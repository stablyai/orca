import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fenceHostSpawnsForWslMoveUndo,
  isHostSpawnFencedForWslMoveUndo,
  resetWslMoveUndoSpawnFencesForTests,
  wslMoveUndoSpawnFencedResponse
} from './wsl-move-undo-spawn-fence'

afterEach(() => {
  vi.useRealTimers()
  resetWslMoveUndoSpawnFencesForTests()
})

describe('WSL move undo spawn fence', () => {
  it('holds while any undo of that host holds it', () => {
    const first = fenceHostSpawnsForWslMoveUndo('wsl:Ubuntu')
    const second = fenceHostSpawnsForWslMoveUndo('wsl:Ubuntu')
    first()
    first()
    expect(isHostSpawnFencedForWslMoveUndo('wsl:Ubuntu', 'terminal.create')).toBe(true)
    second()
    expect(isHostSpawnFencedForWslMoveUndo('wsl:Ubuntu', 'terminal.create')).toBe(false)
  })

  it('lifts itself after the cap so a lost release cannot strand the host', () => {
    vi.useFakeTimers()
    fenceHostSpawnsForWslMoveUndo('wsl:Ubuntu')
    vi.advanceTimersByTime(119_999)
    expect(isHostSpawnFencedForWslMoveUndo('wsl:Ubuntu', 'agentSession.ensure')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(isHostSpawnFencedForWslMoveUndo('wsl:Ubuntu', 'agentSession.ensure')).toBe(false)
  })

  it('answers a refused start as a failed call from the host', () => {
    expect(wslMoveUndoSpawnFencedResponse({ runtimeId: 'rt-1' }, 'terminal.create')).toMatchObject({
      id: 'terminal.create',
      ok: false,
      error: { code: 'wsl_move_undo_in_progress' },
      _meta: { runtimeId: 'rt-1' }
    })
  })
})
