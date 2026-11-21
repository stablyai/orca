import { afterEach, describe, expect, it } from 'vitest'
import { ForegroundAgentExitWatches } from './foreground-agent-exit-watches'
import { setProcessExitWatchNativeForTests } from './native-process-exit-watch'

describe('ForegroundAgentExitWatches', () => {
  afterEach(() => setProcessExitWatchNativeForTests(undefined))

  it('watches the agent a full read proved, not the wrapper that leads its process group', () => {
    const watched = new Map<number, () => void>()
    setProcessExitWatchNativeForTests({
      watchProcessExit: (pid, onExit) => {
        watched.set(pid, onExit)
        return pid
      },
      unwatchProcessExit: (id) => watched.delete(id)
    })
    const exits: string[] = []
    const watches = new ForegroundAgentExitWatches((ptyId) => exits.push(ptyId))
    // `bash -c 'codex; read'`: bash (100) leads the group and keeps waiting after codex (200) exits.
    const source = { isAlive: true, foregroundAgentPid: () => 100 }

    expect(watches.noteInspection('pane', source, 'codex', 200)).toBe(true)
    expect([...watched.keys()]).toEqual([200])

    watched.get(200)?.()
    expect(exits).toEqual(['pane'])
  })
})
