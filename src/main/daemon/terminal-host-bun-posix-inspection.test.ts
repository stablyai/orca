import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessTableReader from '../../shared/process-table-snapshot-reader'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type { TerminalProcess } from '../../shared/terminal-process'
import { TerminalHost } from './terminal-host'
import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'

const scans = vi.hoisted(() => ({ full: vi.fn(), fresh: vi.fn(), strict: vi.fn() }))
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTableReader>()),
  getProcessTableSnapshot: scans.full,
  getFreshProcessTableSnapshot: scans.fresh,
  getStrictProcessTableSnapshotWithAge: scans.strict
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const id = 'bun-pane'
let rows: ProcessTableRow[]
let host: TerminalHost | undefined
let physicalExit: () => void

function row(pid: number, ppid: number, command: string, foregroundPid: number): ProcessTableRow {
  return {
    pid,
    ppid,
    command,
    pgid: pid,
    tpgid: foregroundPid,
    stat: pid === foregroundPid ? 'Ss+' : 'Ss',
    tty: 'ttys002'
  }
}

async function createPane(name = '/bin/zsh', pid = 100) {
  host ??= new TerminalHost({
    spawnSubprocess: () => {
      const proc: TerminalProcess & { processNameIsSpawnFile: true } = {
        pid,
        process: name,
        processNameIsSpawnFile: true,
        cols: 80,
        rows: 24,
        onData: () => ({ dispose() {} }),
        onExit: (listener) => {
          physicalExit = () => listener({ exitCode: 0 })
          return { dispose() {} }
        },
        resize() {},
        clear() {},
        write() {},
        kill() {},
        pause() {},
        resume() {}
      }
      return createDaemonPtySubprocessHandle({
        process: proc,
        shellPath: '/bin/zsh',
        spawnCwd: '/tmp',
        env: {},
        startupCommandDeliveredInShellArgs: false,
        reportsChildExitStatus: true,
        sessionId: id,
        startupAgentRecognition: null
      })
    }
  })
  return host.createOrAttach({
    sessionId: id,
    cols: 80,
    rows: 24,
    streamClient: { onData() {}, onExit() {} }
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  scans.full.mockImplementation(async () => rows)
  scans.fresh.mockImplementation(async () => rows)
  scans.strict.mockImplementation(async () => ({ rows, capturedAgeMs: 0 }))
})
afterEach(async () => {
  physicalExit?.()
  await host?.dispose()
  // Each test owns a distinct host incarnation.
  host = undefined
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
})

describe.each(['darwin', 'linux'])('Bun daemon %s inspection', (hostPlatform) => {
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true })
  )

  it('reports the actual foreground command and warns before closing a busy pane', async () => {
    rows = [row(100, 1, '-zsh', 101), row(101, 100, 'vim notes.md', 101)]
    await createPane()
    expect(await host!.inspectProcess(id)).toMatchObject({
      foregroundProcess: 'vim',
      hasChildProcesses: true,
      childProcessEvidence: 'children'
    })
    expect(await host!.confirmForegroundProcess(id)).toBe('vim')
    expect(scans.fresh).toHaveBeenCalledOnce()
  })

  it('proves an idle shell has no children', async () => {
    rows = [row(100, 1, '-zsh', 100)]
    await createPane()
    expect(await host!.inspectProcess(id)).toMatchObject({
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    })
  })

  it('does not mistake the login wrapper for a running user job', async () => {
    rows = [row(100, 1, '/usr/bin/login -fp test', 101), row(101, 100, '-zsh', 101)]
    await createPane('/usr/bin/login')
    expect(await host!.inspectProcess(id)).toMatchObject({
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    })
  })

  it('preserves a confirmed agent when a later foreground scan cannot verify it', async () => {
    rows = [row(100, 1, '-zsh', 101), row(101, 100, 'node /usr/local/bin/claude', 101)]
    await createPane()
    expect(await host!.confirmForegroundProcess(id)).toBe('claude')
    scans.full.mockRejectedValue(new Error('process table unavailable'))
    scans.strict.mockRejectedValue(new Error('process table unavailable'))
    scans.fresh.mockRejectedValue(new Error('process table unavailable'))
    expect(await host!.inspectProcess(id)).toMatchObject({
      foregroundProcess: 'claude',
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable',
      foregroundProcessEvidence: { verdict: 'unverifiable' }
    })
    expect(await host!.confirmForegroundProcess(id)).toBeNull()
  })

  it('returns uncertainty when the process table has no pane root', async () => {
    rows = [row(900, 1, '-zsh', 900)]
    await createPane()
    expect(await host!.inspectProcess(id)).toMatchObject({
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable',
      foregroundProcessEvidence: { verdict: 'unverifiable' }
    })
  })

  it('does not publish live evidence after physical exit during a child scan', async () => {
    rows = [row(100, 1, '-zsh', 101), row(101, 100, 'vim notes.md', 101)]
    await createPane()
    scans.strict.mockImplementationOnce(async () => {
      physicalExit()
      return { rows, capturedAgeMs: 0 }
    })
    expect(await host!.inspectProcess(id)).toMatchObject({
      foregroundProcess: null,
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable',
      foregroundProcessEvidence: { verdict: 'unverifiable' }
    })
  })
  it('does not cache an agent in a replacement incarnation after a delayed confirmation', async () => {
    rows = [row(100, 1, '-zsh', 101), row(101, 100, 'node /usr/local/bin/claude', 101)]
    const original = await createPane()
    scans.fresh.mockImplementationOnce(async () => {
      const observed = rows
      physicalExit()
      rows = [row(100, 1, '-zsh', 100)]
      const replacement = await createPane()
      expect(replacement.incarnationId).not.toBe(original.incarnationId)
      return observed
    })
    expect(await host!.confirmForegroundProcess(id)).toBeNull()
    expect(await host!.confirmForegroundProcess(id)).toBe('zsh')
  })
})
