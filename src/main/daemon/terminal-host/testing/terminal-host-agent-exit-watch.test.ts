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
    /** A new process that reuses an exited pid. */
    reuse(pid: number): void {
      exited.delete(pid)
    },
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
  let foreground: string | null
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
      onSessionForegroundChange: (sessionId) => agentExits.push(sessionId)
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
    const first = await host.inspectProcess('pane-1', { foregroundOnly: true })
    expect(first.foregroundExitWatched).toBe(true)
    expect([...fake.live.values()].map((watch) => watch.pid)).toEqual([4242])

    fake.exit(4242)
    expect(agentExits).toEqual(['pane-1'])
    expect(fake.live.size).toBe(0)

    // A read that still names the dead pid (its process group outlived it) neither re-arms nor re-reports,
    // and tells the pane no notice is coming.
    const stale = await host.inspectProcess('pane-1', { foregroundOnly: true })
    expect(stale.foregroundExitWatched).toBeUndefined()
    expect(agentExits).toEqual(['pane-1'])
    expect(fake.live.size).toBe(0)

    // Once the shell is back, a new agent that reuses the pid is watched again.
    foreground = 'zsh'
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    foreground = 'codex'
    fake.reuse(4242)
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    expect([...fake.live.values()].map((watch) => watch.pid)).toEqual([4242])
  })

  it('keeps the watch through a read that could not see the foreground', async () => {
    await createSession()
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    foreground = null
    await host.inspectProcess('pane-1', { foregroundOnly: true })
    expect(fake.live.size).toBe(1)
    fake.exit(4242)
    expect(agentExits).toEqual(['pane-1'])
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
    // The pane may still count on a notice, so it is told to read again.
    expect(agentExits).toEqual(['pane-1'])

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
    expect(agentExits).toEqual(['pane-1'])
  })

  it('answers a Windows read with the agent a lookup finds after the shell name was returned', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    let name = 'pwsh.exe'
    let exitWindowsShell: (code: number) => void = () => {}
    const windowsHost = new TerminalHost({
      spawnSubprocess: () =>
        ({
          pid: 99998,
          getForegroundProcess: () => name,
          // The lookup the shell name started lands while the read waits for it.
          pendingForegroundRefresh: () =>
            Promise.resolve().then(() => {
              name = 'codex'
            }),
          inspectChildProcesses: () => 'no-children',
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(() => exitWindowsShell(0)),
          terminateOwnedTree: () => 'unavailable',
          forceKill: vi.fn(() => exitWindowsShell(137)),
          signal: vi.fn(),
          onData: vi.fn(),
          onExit: (cb: (code: number) => void) => {
            exitWindowsShell = cb
          },
          dispose: vi.fn()
        }) satisfies SubprocessHandle
    })
    await windowsHost.createOrAttach({
      sessionId: 'pane-win',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    const result = await windowsHost.inspectProcess('pane-win', {
      steadyState: true,
      jobMembershipOnly: true
    })
    expect(result.foregroundProcess).toBe('codex')
    await windowsHost.dispose()
  })

  it('reads a Windows shell’s escaped children even when the pane asked for job membership only', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    let exitWindowsShell: (code: number) => void = () => {}
    // A Store shell is alone in its job while its child runs outside it; only the table read sees the child.
    const inspectChildProcesses = vi.fn(
      (_fresh?: boolean, _ignoreDetached?: boolean, jobMembershipOnly?: boolean) =>
        jobMembershipOnly ? ('no-children' as const) : ('children' as const)
    )
    const windowsHost = new TerminalHost({
      spawnSubprocess: () =>
        ({
          pid: 99997,
          getForegroundProcess: () => 'pwsh.exe',
          inspectChildProcesses,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(() => exitWindowsShell(0)),
          terminateOwnedTree: () => 'unavailable',
          forceKill: vi.fn(() => exitWindowsShell(137)),
          signal: vi.fn(),
          onData: vi.fn(),
          onExit: (cb: (code: number) => void) => {
            exitWindowsShell = cb
          },
          dispose: vi.fn()
        }) satisfies SubprocessHandle
    })
    await windowsHost.createOrAttach({
      sessionId: 'pane-store',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    const result = await windowsHost.inspectProcess('pane-store', {
      steadyState: true,
      jobMembershipOnly: true
    })
    expect(result.childProcessEvidence).toBe('children')
    // Only a full census that finds the shell alone proves the pane idle.
    expect(result.idleShellProven).toBeUndefined()
    inspectChildProcesses.mockReturnValue('no-children')
    const idle = await windowsHost.inspectProcess('pane-store', {
      steadyState: true,
      jobMembershipOnly: true
    })
    expect(idle.idleShellProven).toBe(true)
    await windowsHost.dispose()
  })
})
