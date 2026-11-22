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
    const source = { isAlive: true, foregroundAgentPid: () => 100 }

    expect(watches.noteInspection('pane', source, 'codex', 200)).toBe(true)
    expect([...watched.keys()]).toEqual([200])

    exit(200)
    expect(notices).toEqual(['pane'])
  })

  it('a command that hands off to a silent agent prompts the read that finds it', () => {
    // `sleep 30; codex exec … > run.log`: the agent starts with no output, title or hook.
    const source = { isAlive: true, foregroundAgentPid: () => null }

    expect(watches.noteInspection('pane', source, 'sleep', 300)).toBe(true)
    exit(300)
    expect(notices).toEqual(['pane'])

    expect(watches.noteInspection('pane', source, 'codex', 301)).toBe(true)
    expect([...watched.keys()]).toEqual([301])

    // Back at the shell the agent's watch is released and the pane told to read again.
    watches.noteInspection('pane', source, 'zsh')
    expect(watched.size).toBe(0)
    expect(notices).toEqual(['pane', 'pane'])
  })

  it('leaves a command whose group leader already left unwatched, so the pane keeps reading', () => {
    // `printf x | sleep 60; codex …`: the group id names printf, which is gone while sleep runs on.
    setProcessExitWatchNativeForTests({ watchProcessExit: () => 0, unwatchProcessExit: () => {} })
    const source = { isAlive: true, foregroundAgentPid: () => null }

    expect(watches.noteInspection('pane', source, 'sleep', 400)).toBe(false)
    expect(watches.noteInspection('pane', source, 'sleep', 400)).toBe(false)
    expect(notices).toEqual([])
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
      foregroundAgentPid: () => agentPid,
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
