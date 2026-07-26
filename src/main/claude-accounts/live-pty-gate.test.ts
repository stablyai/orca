import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachClaudeLivePtyPersistence,
  beginClaudeAuthSwitch,
  confirmSeededClaudeLivePtys,
  endClaudeAuthSwitch,
  hasLiveClaudePtys,
  isClaudeAuthSwitchInProgress,
  markClaudePtyExited,
  markClaudePtySpawned,
  seedLiveClaudePtysFromPersistence
} from './live-pty-gate'

describe('Claude live PTY gate', () => {
  afterEach(() => {
    markClaudePtyExited('live-claude-pty')
    markClaudePtyExited('seeded-pty-1')
    markClaudePtyExited('seeded-pty-2')
    confirmSeededClaudeLivePtys([])
    attachClaudeLivePtyPersistence(null)
    endClaudeAuthSwitch()
  })

  it('allows switching while Claude PTYs are live', () => {
    markClaudePtySpawned('live-claude-pty')

    beginClaudeAuthSwitch()

    expect(isClaudeAuthSwitchInProgress()).toBe(true)
  })

  it('still rejects overlapping account switches', () => {
    beginClaudeAuthSwitch()

    expect(() => beginClaudeAuthSwitch()).toThrow('already in progress')
  })

  it('counts seeded session ids as live until confirmed dead', () => {
    seedLiveClaudePtysFromPersistence(['seeded-pty-1', 'seeded-pty-2'])

    expect(hasLiveClaudePtys()).toBe(true)

    confirmSeededClaudeLivePtys(['seeded-pty-1'])

    expect(hasLiveClaudePtys()).toBe(true)

    confirmSeededClaudeLivePtys([])

    expect(hasLiveClaudePtys()).toBe(true)

    markClaudePtyExited('seeded-pty-1')

    expect(hasLiveClaudePtys()).toBe(false)
  })

  it('releases seeded ids the daemon no longer knows', () => {
    const removeClaudeLivePtySessionId = vi.fn()
    attachClaudeLivePtyPersistence({
      addClaudeLivePtySessionId: vi.fn(),
      removeClaudeLivePtySessionId
    })
    seedLiveClaudePtysFromPersistence(['seeded-pty-1', 'seeded-pty-2'])

    confirmSeededClaudeLivePtys(['seeded-pty-2'])

    expect(hasLiveClaudePtys()).toBe(true)
    expect(removeClaudeLivePtySessionId).toHaveBeenCalledWith('seeded-pty-1')
    expect(removeClaudeLivePtySessionId).not.toHaveBeenCalledWith('seeded-pty-2')
  })

  it('keeps a seeded id confirmed by a real spawn out of later pruning', () => {
    seedLiveClaudePtysFromPersistence(['seeded-pty-1'])
    markClaudePtySpawned('seeded-pty-1')

    confirmSeededClaudeLivePtys([])

    expect(hasLiveClaudePtys()).toBe(true)
  })

  it('persists spawns and exits when persistence is attached', () => {
    const addClaudeLivePtySessionId = vi.fn()
    const removeClaudeLivePtySessionId = vi.fn()
    attachClaudeLivePtyPersistence({
      addClaudeLivePtySessionId,
      removeClaudeLivePtySessionId
    })

    markClaudePtySpawned('live-claude-pty')
    expect(addClaudeLivePtySessionId).toHaveBeenCalledWith('live-claude-pty')

    markClaudePtyExited('live-claude-pty')
    expect(removeClaudeLivePtySessionId).toHaveBeenCalledWith('live-claude-pty')
  })
})
