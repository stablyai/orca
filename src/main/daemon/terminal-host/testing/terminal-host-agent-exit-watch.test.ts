/** A foreground agent that exits without printing must still reach the pane, with no timer and no leaked watch. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from '../terminal-host'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { setProcessExitWatchNativeForTests } from '../../../pty/process-retirement/native-process-exit-watch'

vi.mock('../../../pty/process-retirement/pty-descendant-termination', () => ({
  killWithDescendantSweep: vi.fn(async () => {})
}))

function createFakeExitWatchNative() {
  const live = new Map<number, { pid: number; onExit: () => void }>()
  let nextId = 0
  const exited = new Set<number>()
  return {
    live,
    exit(pid: number): void {
      exited.add(pid)
      for (const [id, watch] of live) {
        if (watch.pid === pid) {
          live.delete(id)
          watch.onExit()
        }
      }
    },
    native: {
      watchProcessExit: (pid: number, onExit: () => void): number | null => {
        if (exited.has(pid)) {
          return 0
        }
        nextId += 1
        live.set(nextId, { pid, onExit })
        return nextId
      },
      unwatchProcessExit: (id: number): void => {
        live.delete(id)
      }
    }
  }
}

describe('TerminalHost foreground agent exit watch', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  let fake: ReturnType<typeof createFakeExitWatchNative>
  let foreground: string
  let agentPid: number
  let exitShell: (code: number) => void
  let host: TerminalHost
  let agentExits: string[]

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    fake = createFakeExitWatchNative()
    setProcessExitWatchNativeForTests(fake.native)
    foreground = 'codex'
    agentPid = 4242
    exitShell = () => {}
    agentExits = []
    host = new TerminalHost({
      spawnSubprocess: () =>
        ({
          pid: 99999,
          getForegroundProcess: () => foreground,
          observeForeground: async () => ({
            verdict: 'observed',
            source: 'pty-master',
            foregroundKind: 'non-shell',
            processName: foreground
          }),
          foregroundAgentPid: () => agentPid,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(() => exitShell(0)),
          terminateOwnedTree: () => 'unavailable',
          forceKill: vi.fn(() => exitShell(137)),
          signal: vi.fn(),
          onData: vi.fn(),
          onExit: (cb: (code: number) => void) => {
            exitShell = cb
          },
          dispose: vi.fn()
        }) satisfies SubprocessHandle,
      onSessionAgentExit: (sessionId) => agentExits.push(sessionId)
    })
  })

  afterEach(async () => {
    await host.dispose()
    setProcessExitWatchNativeForTests(undefined)
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  async function createSession(): Promise<void> {
    await host.createOrAttach({
      sessionId: 'pane-1',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  }

  it('reports a silent agent exit once and keeps no watch afterwards', async () => {
    await createSession()
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    expect([...fake.live.values()].map((watch) => watch.pid)).toEqual([4242])

    fake.exit(4242)
    expect(agentExits).toEqual(['pane-1'])
    expect(fake.live.size).toBe(0)

    // A read that still names the dead pid (its process group outlived it) neither re-arms nor re-reports.
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    expect(agentExits).toEqual(['pane-1'])
    expect(fake.live.size).toBe(0)
  })

  it('reports an agent that exited before its watch was armed', async () => {
    await createSession()
    fake.exit(4242)
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    expect(agentExits).toEqual(['pane-1'])
    expect(fake.live.size).toBe(0)
  })

  it('releases the watch when the foreground is no longer an agent, when the pane exits, and on dispose', async () => {
    await createSession()
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    foreground = 'vim'
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    expect(fake.live.size).toBe(0)

    foreground = 'codex'
    agentPid = 5151
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    expect(fake.live.size).toBe(1)
    exitShell(0)
    await vi.waitFor(() => expect(host.listSessions()).toHaveLength(0))
    expect(fake.live.size).toBe(0)

    await createSession()
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    expect(fake.live.size).toBe(1)
    await host.dispose()
    expect(fake.live.size).toBe(0)
    expect(agentExits).toEqual([])
  })
})
