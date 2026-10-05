import { describe, expect, it, vi } from 'vitest'
import { runtimeWorktreeIdentityKey } from './runtime-worktree-path-identity'
import {
  hostWorktreeSleepBlocksAutomaticRecovery,
  settleWorktreeSpawnSleep,
  type WorktreeTerminalSleepSnapshot
} from './worktree-terminal-spawn-sleep-disposition'

const WORKTREE_ID = 'repo::/tmp/workspace'

function sleepingSnapshot(
  phase: WorktreeTerminalSleepSnapshot['phase']
): WorktreeTerminalSleepSnapshot {
  return {
    worktreeId: WORKTREE_ID,
    generation: 4,
    phase,
    ptyIds: ['pty-1'],
    terminalHandles: ['term-1'],
    terminalHandlesByPtyId: { 'pty-1': ['term-1'] }
  }
}

describe('host worktree sleep versus automatic recovery', () => {
  it('treats an in-progress or committed sleep as deliberate', () => {
    expect(hostWorktreeSleepBlocksAutomaticRecovery('stopping')).toBe(true)
    expect(hostWorktreeSleepBlocksAutomaticRecovery('sleeping')).toBe(true)
    expect(hostWorktreeSleepBlocksAutomaticRecovery('partial')).toBe(true)
    expect(hostWorktreeSleepBlocksAutomaticRecovery(undefined)).toBe(false)
  })

  it('leaves a committed sleep in place for an automatic spawn', () => {
    const sleepStates = new Map([
      [runtimeWorktreeIdentityKey(WORKTREE_ID), sleepingSnapshot('sleeping')]
    ])
    const emitWoken = vi.fn()

    expect(settleWorktreeSpawnSleep(sleepStates, WORKTREE_ID, 'leave', emitWoken)).toBe(true)

    expect(emitWoken).not.toHaveBeenCalled()
    expect(sleepStates.get(runtimeWorktreeIdentityKey(WORKTREE_ID))?.phase).toBe('sleeping')
  })

  it('clears a committed sleep for an explicit spawn', () => {
    const snapshot = sleepingSnapshot('partial')
    const sleepStates = new Map([[runtimeWorktreeIdentityKey(WORKTREE_ID), snapshot]])
    const emitWoken = vi.fn()

    expect(settleWorktreeSpawnSleep(sleepStates, WORKTREE_ID, 'wake', emitWoken)).toBe(false)

    expect(sleepStates.size).toBe(0)
    expect(emitWoken).toHaveBeenCalledOnce()
    expect(emitWoken).toHaveBeenCalledWith({
      type: 'worktreeTerminalSleepState',
      worktreeId: snapshot.worktreeId,
      generation: snapshot.generation,
      phase: 'woken',
      ptyIds: snapshot.ptyIds,
      terminalHandles: snapshot.terminalHandles
    })
  })
})
