/**
 * ConPTY from a process started the way a Windows SSH host starts orcad: the slot's
 * process-tree addon `spawnOutsideJob` (CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW, stdio to
 * files, no inherited pipes). orcad's terminals live or die on node-pty working there, with no
 * visible console and no parent session, so this spawns a shell, writes to it, reads its output
 * and sees it exit from inside such a process.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { quoteWindowsArgument } from '../../shared/child-process/windows-command-line'
import {
  ORCAD_NODE_PTY_DIR,
  ORCAD_WINDOWS_PROCESS_TREE_FILENAME
} from '../../shared/orcad-artifacts'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import {
  installPackagedOrcadSlotForTests,
  locatePinnedNodeForTests,
  skipForMissingInputs
} from './orcad-node-slot-fixture'

const pinnedNode = locatePinnedNodeForTests()
const windows = process.platform === 'win32'
const skip = skipForMissingInputs(
  'artifact',
  windows
    ? [
        ...(pinnedNode ? [] : ['the pinned Node (ORCA_PINNED_NODE or out/runtimes)']),
        ...(existsSync(join('out/orcad', ORCAD_WINDOWS_PROCESS_TREE_FILENAME))
          ? []
          : [`out/orcad/${ORCAD_WINDOWS_PROCESS_TREE_FILENAME}`])
      ]
    : []
)

const SMOKE = `
const pty = require(process.argv[2])
const shell = process.env.ComSpec || 'cmd.exe'
let output = ''
const deadline = setTimeout(() => { console.log(JSON.stringify({ timedOut: true, output })); process.exit(98) }, 20000)
const term = pty.spawn(shell, [], { cols: 80, rows: 24, cwd: process.cwd(), useConpty: true })
term.onData((data) => { output += data })
term.onExit(({ exitCode }) => {
  clearTimeout(deadline)
  console.log(JSON.stringify({ exitCode, read: output.includes('ORCA_CONPTY_SMOKE_OK') }))
  process.exit(0)
})
term.write('echo ORCA_CONPTY_SMOKE_%COMPUTERNAME:~0,0%OK & exit 17\\r')
`

let root = ''
afterEach(() => {
  if (root) {
    removeTreeSync(root)
  }
})

describe.skipIf(skip || !windows)('ConPTY in a broken-away, windowless orcad process', () => {
  it('spawns a shell, writes, reads its output and sees it exit', async (context) => {
    root = mkdtempSync(join(tmpdir(), 'orcad-conpty-breakaway-'))
    const { slotDir, runtime } = installPackagedOrcadSlotForTests(root, pinnedNode!)
    const script = join(root, 'conpty-smoke.cjs')
    writeFileSync(script, SMOKE)
    const stdoutPath = join(root, 'smoke.out')
    const stderrPath = join(root, 'smoke.err')
    // From out/orcad, not the temp slot: a loaded .node stays mapped and pins its directory.
    const addon: unknown = createRequire(import.meta.url)(
      resolve('out/orcad', ORCAD_WINDOWS_PROCESS_TREE_FILENAME)
    )
    const spawn =
      addon && typeof addon === 'object' && 'spawnOutsideJob' in addon
        ? addon.spawnOutsideJob
        : undefined
    if (typeof spawn !== 'function') {
      throw new Error('the slot addon does not export spawnOutsideJob')
    }
    const commandLine = [runtime, script, join(slotDir, ORCAD_NODE_PTY_DIR)]
      .map(quoteWindowsArgument)
      .join(' ')
    const result: unknown = spawn(runtime, commandLine, root, stdoutPath, stderrPath)
    const record =
      result && typeof result === 'object' ? Object.fromEntries(Object.entries(result)) : {}
    if (record.reason === 'breakaway-denied') {
      // A runner whose own job forbids breakaway cannot host this check; Windows SSH hosts allow it.
      context.skip()
    }
    expect(record, JSON.stringify(record)).toMatchObject({ ok: true })

    let report: Record<string, unknown> | null = null
    await vi.waitFor(
      () => {
        const line = existsSync(stdoutPath)
          ? readFileSync(stdoutPath, 'utf8')
              .split(/\r?\n/u)
              .find((candidate) => candidate.startsWith('{'))
          : undefined
        if (!line) {
          const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : ''
          throw new Error(`no smoke report yet: ${stderr.slice(-2000)}`)
        }
        report = JSON.parse(line)
      },
      { timeout: 30_000, interval: 250 }
    )
    expect(report).toEqual({ exitCode: 17, read: true })
  }, 60_000)
})
