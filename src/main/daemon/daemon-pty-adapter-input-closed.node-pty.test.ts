import './mock-descendant-sweep'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as pty from 'node-pty'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadNodePtyForTests } from '../orcad/orcad-node-slot-fixture'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const SESSION_ID = 'adapter-input-closed'

// #33021: `orca terminal send` reported delivery while the child received nothing.
describePosix('daemon adapter writes to a live session whose PTY stopped taking input', () => {
  let nodePty: typeof pty
  let harness: DaemonAdapterHarness | null = null
  let native: pty.IPty | null = null
  let exited = false
  let root = ''
  const adapters: DaemonPtyAdapter[] = []
  const spawned = (): pty.IPty => {
    if (!native) {
      throw new Error('the daemon has not spawned the PTY')
    }
    return native
  }
  beforeAll(async () => {
    nodePty = await loadNodePtyForTests()
  })
  afterEach(async () => {
    if (native && !exited) {
      native.kill('SIGKILL')
    }
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 3000 })
    for (const adapter of adapters.splice(0)) {
      adapter.dispose()
    }
    await harness?.server.shutdown()
    rmSync(harness?.dir ?? '', { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses writes once the daemon reports closed input, including after a main restart', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-adapter-input-closed-'))
    const log = join(root, 'stdin.log')
    harness = await startDaemonAdapterHarness(() => {
      native = nodePty.spawn(
        '/bin/sh',
        [
          '-c',
          `printf "ready\\n"; while IFS= read -r line; do printf "%s\\n" "$line" >> "${log}"; done`
        ],
        { cwd: root, cols: 80, rows: 24, env: { TERM: 'xterm-256color', PATH: '/usr/bin:/bin' } }
      )
      native.onExit(() => {
        exited = true
      })
      return createDaemonPtySubprocessHandle({
        process: native,
        shellPath: '/bin/sh',
        spawnCwd: root,
        env: {},
        startupCommandDeliveredInShellArgs: false,
        reportsChildExitStatus: true,
        sessionId: SESSION_ID,
        startupAgentRecognition: null
      })
    })
    const { adapter, socketPath, tokenPath } = harness
    adapters.push(adapter)
    const logged = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '')
    await adapter.spawn({ cols: 80, rows: 24, sessionId: SESSION_ID })
    expect(adapter.write(SESSION_ID, 'before\n')).toBe(true)
    await vi.waitFor(() => expect(logged()).toContain('before'), { timeout: 3000 })

    vi.spyOn(spawned(), 'resize').mockImplementationOnce(() => {
      throw new Error('ioctl(2) failed, EBADF')
    })
    adapter.resize(SESSION_ID, 100, 30)

    await vi.waitFor(() => expect(adapter.write(SESSION_ID, 'after\n')).toBe(false), {
      timeout: 3000
    })
    await expect(adapter.writeWithSettlement(SESSION_ID, 'after\n')).resolves.toEqual({
      outcome: 'refused',
      reason: 'provider_refused_write'
    })
    expect(harness.daemonLogEvents).toContain('pty-input-closed')

    const restarted = new DaemonPtyAdapter({ socketPath, tokenPath })
    adapters.push(restarted)
    const reattached = await restarted.spawn({ cols: 100, rows: 30, sessionId: SESSION_ID })
    expect(reattached.isReattach).toBe(true)
    expect(restarted.write(SESSION_ID, 'after\n')).toBe(false)
    expect(process.kill(spawned().pid, 0)).toBe(true)
    expect(logged()).toBe('before\n')
  })
})
