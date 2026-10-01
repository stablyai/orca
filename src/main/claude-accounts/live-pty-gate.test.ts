import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachClaudeLivePtyPersistence,
  beginClaudeAuthSwitch,
  confirmSeededClaudeLivePtys,
  endClaudeAuthSwitch,
  hasLiveClaudePtys,
  hasLiveClaudePtysHoldingAccount,
  isClaudeAuthSwitchInProgress,
  markClaudePtyExited,
  markClaudePtySpawned,
  markClaudeStructuredChildExited,
  markClaudeStructuredChildSpawned,
  onLiveClaudePtysDrained,
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

  it('notifies drain listeners only when the last live Claude PTY exits', () => {
    const onDrained = vi.fn()
    const unsubscribe = onLiveClaudePtysDrained(onDrained)
    try {
      markClaudePtySpawned('live-claude-pty')
      markClaudePtySpawned('seeded-pty-1')

      markClaudePtyExited('live-claude-pty')
      expect(onDrained).not.toHaveBeenCalled()

      markClaudePtyExited('seeded-pty-1')
      expect(onDrained).toHaveBeenCalledTimes(1)

      // Why: exits with no live PTYs left must not fire again — the drain
      // signal marks the 1 -> 0 transition, not every teardown call.
      markClaudePtyExited('seeded-pty-1')
      expect(onDrained).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('notifies drain listeners when seed reconciliation releases the last live id', () => {
    const onDrained = vi.fn()
    const unsubscribe = onLiveClaudePtysDrained(onDrained)
    try {
      seedLiveClaudePtysFromPersistence(['seeded-pty-1'])

      confirmSeededClaudeLivePtys([])

      expect(onDrained).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('stops notifying an unsubscribed drain listener', () => {
    const onDrained = vi.fn()
    const unsubscribe = onLiveClaudePtysDrained(onDrained)
    unsubscribe()

    markClaudePtySpawned('live-claude-pty')
    markClaudePtyExited('live-claude-pty')

    expect(onDrained).not.toHaveBeenCalled()
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

  describe('account lineage', () => {
    afterEach(() => {
      markClaudeStructuredChildExited('structured-child')
    })

    it('scopes a managed launch to the account it launched under', () => {
      markClaudePtySpawned('live-claude-pty', 'managed:account-1')

      expect(hasLiveClaudePtysHoldingAccount('account-1')).toBe(true)
      expect(hasLiveClaudePtysHoldingAccount('account-2')).toBe(false)
      expect(hasLiveClaudePtys()).toBe(true)
    })

    it.each([
      ['system default', 'system'],
      ['WSL managed', 'managed:account-2:wsl:Ubuntu'],
      ['WSL system default', 'wsl:Ubuntu:system'],
      ['missing', undefined]
    ])('treats a %s launch as holding every account', (_label, provenance) => {
      markClaudePtySpawned('live-claude-pty', provenance)

      expect(hasLiveClaudePtysHoldingAccount('account-2')).toBe(true)
    })

    it('treats sessions seeded after a restart as holding every account', () => {
      seedLiveClaudePtysFromPersistence(['seeded-pty-1'])

      expect(hasLiveClaudePtysHoldingAccount('account-2')).toBe(true)
    })

    it('treats structured Claude children as holding every account', () => {
      markClaudeStructuredChildSpawned('structured-child')

      expect(hasLiveClaudePtysHoldingAccount('account-2')).toBe(true)
    })

    it('reports no holder once every session is gone', () => {
      markClaudePtySpawned('live-claude-pty', 'managed:account-2')
      markClaudePtyExited('live-claude-pty')

      expect(hasLiveClaudePtysHoldingAccount('account-2')).toBe(false)
    })
  })
})
