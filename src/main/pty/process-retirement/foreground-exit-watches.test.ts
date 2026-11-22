import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ForegroundExitWatches } from './foreground-exit-watches'
import { setProcessExitWatchNativeForTests } from './native-process-exit-watch'

describe('ForegroundExitWatches', () => {
  let watched: Map<number, () => void>
  let notices: string[]
  let watches: ForegroundExitWatches

  beforeEach(() => {
    watched = new Map()
    notices = []
    setProcessExitWatchNativeForTests({
      watchProcessExit: (pid, onExit) => {
        watched.set(pid, onExit)
        return pid
      },
      unwatchProcessExit: (id) => watched.delete(id)
    })
    watches = new ForegroundExitWatches((ptyId) => notices.push(ptyId))
  })
  afterEach(() => setProcessExitWatchNativeForTests(undefined))

  function exit(pid: number): void {
    const onExit = watched.get(pid)
    watched.delete(pid)
    onExit?.()
  }

  it('watches the agent a full read proved, not the wrapper that leads its process group', () => {
    // `bash -c 'codex; read'`: bash (100) leads the group and keeps waiting after codex (200) exits.
    const source = { isAlive: true, foregroundAgent: () => ({ processName: 'bash', pid: 100 }) }

    expect(watches.noteInspection('pane', source, 'codex', 200)).toBe(true)
    expect([...watched.keys()]).toEqual([200])

    exit(200)
    expect(notices).toEqual(['pane'])
  })

  it('lets a read without a pid lean on a watch only for the agent that watch belongs to', () => {
    // Codex keeps running in the background; Claude takes the foreground and the capture fails.
    const source = { isAlive: true, foregroundAgent: () => null }
    expect(watches.noteInspection('pane', source, 'codex', 10)).toBe(true)

    expect(watches.noteInspection('pane', source, 'claude')).toBe(false)
    expect(watches.noteInspection('pane', source, 'codex')).toBe(true)
  })

  it('does not pair a read’s agent with the pid of another agent a later lookup cached', () => {
    // Windows: the read named Codex, but the lookup that landed during the child census cached Gemini.
    const source = {
      isAlive: true,
      foregroundAgent: () => ({ processName: 'gemini.exe', pid: 77 })
    }

    expect(watches.noteInspection('pane', source, 'codex.exe')).toBe(false)
    expect(watched.size).toBe(0)
    expect(notices).toEqual(['pane'])
    // The same disagreement does not notify again.
    expect(watches.noteInspection('pane', source, 'codex.exe')).toBe(false)
    expect(notices).toEqual(['pane'])
    expect(watches.noteInspection('pane', source, 'gemini.exe')).toBe(true)
  })

  it('announces once an agent a lookup names after the read returned', async () => {
    let agentPid: number | null = null
    let land: () => void = () => {}
    const lookup = new Promise<void>((resolve) => {
      land = resolve
    })
    let pending: Promise<void> | null = lookup
    const source = {
      isAlive: true,
      foregroundAgent: () =>
        agentPid === null ? null : { processName: 'codex.exe', pid: agentPid },
      pendingForegroundRefresh: () => pending
    }

    expect(watches.noteInspection('pane', source, 'pwsh.exe')).toBe(false)
    watches.noteInspection('pane', source, 'pwsh.exe')
    agentPid = 77
    pending = null
    land()
    await lookup
    await Promise.resolve()
    expect(notices).toEqual(['pane'])

    expect(watches.noteInspection('pane', source, 'codex.exe')).toBe(true)
    expect(notices).toEqual(['pane'])
  })
})
