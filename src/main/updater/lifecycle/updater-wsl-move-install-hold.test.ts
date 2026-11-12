import { afterEach, describe, expect, it } from 'vitest'
import {
  beginWslMoveUndoRun,
  claimWslMoveRun,
  wslMoveClaimRefusal,
  releaseWslMoveRun,
  type RunningWslMove
} from '../../persistence/moving-wsl-projects/orchestration/wsl-move-running-moves'
import { wslMoveInstallHold } from './updater-wsl-move-install-hold'

const ends: (() => void)[] = []
let move: RunningWslMove | null = null

afterEach(() => {
  ends.splice(0).forEach((end) => end())
  if (move) {
    releaseWslMoveRun('Ubuntu', move)
    releaseWslMoveRun('Debian', move)
    move = null
  }
})

function beginUndo(): () => void {
  const end = beginWslMoveUndoRun('Ubuntu')
  ends.push(end)
  return end
}

describe('wslMoveInstallHold', () => {
  it('holds until every undo has ended, and an end counts once', () => {
    const first = beginUndo()
    const second = beginUndo()
    first()
    first()
    expect(wslMoveInstallHold()).not.toBeNull()
    second()
    expect(wslMoveInstallHold()).toBeNull()
  })

  it("refuses a move or preview of the undone distro until its undo ends, not another distro's", () => {
    const end = beginUndo()
    // Case-insensitive like the journal key: WSL names distros case-insensitively.
    expect(claimWslMoveRun('ubuntu')).toBeNull()
    expect(wslMoveClaimRefusal('Ubuntu')).toBe('wsl_move_undo_running')
    move = claimWslMoveRun('Debian')
    expect(move).not.toBeNull()
    // A move, not an undo, holds Debian.
    expect(wslMoveClaimRefusal('Debian')).toBe('wsl_move_already_running')
    end()
    const after = claimWslMoveRun('Ubuntu')
    expect(after).not.toBeNull()
    if (after) {
      releaseWslMoveRun('Ubuntu', after)
    }
  })
})
