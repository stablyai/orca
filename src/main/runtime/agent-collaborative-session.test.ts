/**
 * Unit tests for the Collaborative Session Tracker (P2-1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CollaborativeSessionTracker } from './agent-collaborative-session'
import { COLLABORATIVE_SESSION_CONFIG } from '../../shared/agent-collaborative-session'

describe('CollaborativeSessionTracker', () => {
  let tracker: CollaborativeSessionTracker

  beforeEach(() => {
    tracker = new CollaborativeSessionTracker()
  })

  afterEach(() => {
    tracker.clear()
  })

  describe('create', () => {
    it('creates a session with the given participants', () => {
      const session = tracker.create({ participantKeyIds: ['codex-1', 'pi-1'] })

      expect(session.sessionId).toBeTruthy()
      expect(session.participantKeyIds).toEqual(['codex-1', 'pi-1'])
      expect(session.createdAt).toBeGreaterThan(0)
      expect(session.lastActivityAt).toBe(session.createdAt)
    })

    it('assigns a distinct sessionId to each session', () => {
      const a = tracker.create({ participantKeyIds: ['x'] })
      const b = tracker.create({ participantKeyIds: ['y'] })
      expect(a.sessionId).not.toBe(b.sessionId)
    })

    it('deduplicates participant keyIds, preserving first-occurrence order', () => {
      const session = tracker.create({
        participantKeyIds: ['codex-1', 'pi-1', 'codex-1', 'pi-1', 'prime-1']
      })
      expect(session.participantKeyIds).toEqual(['codex-1', 'pi-1', 'prime-1'])
    })

    it('accepts a single-participant session (MIN_PARTICIPANTS = 1)', () => {
      const session = tracker.create({ participantKeyIds: ['solo-1'] })
      expect(session.participantKeyIds).toEqual(['solo-1'])
    })

    it('stores optional metadata', () => {
      const metadata = { label: 'debugging together' }
      const session = tracker.create({ participantKeyIds: ['a', 'b'], metadata })
      expect(session.metadata).toEqual(metadata)
    })

    it('throws for an empty participant list', () => {
      expect(() => tracker.create({ participantKeyIds: [] })).toThrow(
        'collaborative_session_too_few_participants'
      )
    })

    it('throws when participants exceed MAX_PARTICIPANTS_PER_SESSION', () => {
      const tooMany = Array.from(
        { length: COLLABORATIVE_SESSION_CONFIG.MAX_PARTICIPANTS_PER_SESSION + 1 },
        (_, i) => `agent-${i}`
      )
      expect(() => tracker.create({ participantKeyIds: tooMany })).toThrow(
        'collaborative_session_too_many_participants'
      )
    })

    it('allows exactly MAX_PARTICIPANTS_PER_SESSION participants', () => {
      const exactlyMax = Array.from(
        { length: COLLABORATIVE_SESSION_CONFIG.MAX_PARTICIPANTS_PER_SESSION },
        (_, i) => `agent-${i}`
      )
      const session = tracker.create({ participantKeyIds: exactlyMax })
      expect(session.participantKeyIds).toHaveLength(
        COLLABORATIVE_SESSION_CONFIG.MAX_PARTICIPANTS_PER_SESSION
      )
    })

    it('does not let duplicates in the input list bypass the max-participants cap', () => {
      // MAX + 1 raw entries, but only 2 distinct keyIds after dedup -> must succeed.
      const raw = Array.from(
        { length: COLLABORATIVE_SESSION_CONFIG.MAX_PARTICIPANTS_PER_SESSION + 5 },
        (_, i) => (i % 2 === 0 ? 'a' : 'b')
      )
      const session = tracker.create({ participantKeyIds: raw })
      expect(session.participantKeyIds).toEqual(['a', 'b'])
    })
  })

  describe('get', () => {
    it('retrieves a created session by sessionId', () => {
      const created = tracker.create({ participantKeyIds: ['a', 'b'] })
      const fetched = tracker.get(created.sessionId)
      expect(fetched).toEqual(created)
    })

    it('returns null for an unknown sessionId', () => {
      expect(tracker.get('does-not-exist')).toBeNull()
    })
  })

  describe('list', () => {
    it('lists all sessions when no filter is provided', () => {
      tracker.create({ participantKeyIds: ['a', 'b'] })
      tracker.create({ participantKeyIds: ['c', 'd'] })

      const result = tracker.list()
      expect(result.sessions).toHaveLength(2)
      expect(result.totalCount).toBe(2)
    })

    it('filters by participantKeyId', () => {
      const first = tracker.create({ participantKeyIds: ['a', 'b'] })
      tracker.create({ participantKeyIds: ['c', 'd'] })

      const result = tracker.list({ participantKeyId: 'a' })
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0].sessionId).toBe(first.sessionId)
    })

    it('totalCount reflects the count before filtering', () => {
      tracker.create({ participantKeyIds: ['a', 'b'] })
      tracker.create({ participantKeyIds: ['c', 'd'] })

      const result = tracker.list({ participantKeyId: 'nonexistent' })
      expect(result.sessions).toHaveLength(0)
      expect(result.totalCount).toBe(2)
    })

    it('a session with multiple participants is returned for a filter matching any one of them', () => {
      const session = tracker.create({ participantKeyIds: ['a', 'b', 'c'] })

      expect(tracker.list({ participantKeyId: 'a' }).sessions[0].sessionId).toBe(session.sessionId)
      expect(tracker.list({ participantKeyId: 'b' }).sessions[0].sessionId).toBe(session.sessionId)
      expect(tracker.list({ participantKeyId: 'c' }).sessions[0].sessionId).toBe(session.sessionId)
    })
  })

  describe('addParticipant', () => {
    it('adds a new participant to an existing session', () => {
      const session = tracker.create({ participantKeyIds: ['a', 'b'] })
      const updated = tracker.addParticipant(session.sessionId, 'c')

      expect(updated?.participantKeyIds).toEqual(['a', 'b', 'c'])
    })

    it('is idempotent for an already-present participant', () => {
      const session = tracker.create({ participantKeyIds: ['a', 'b'] })
      const updated = tracker.addParticipant(session.sessionId, 'a')

      expect(updated?.participantKeyIds).toEqual(['a', 'b'])
    })

    it('bumps lastActivityAt even for an idempotent add', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      const session = tracker.create({ participantKeyIds: ['a', 'b'] })
      const createdActivityAt = session.lastActivityAt

      vi.advanceTimersByTime(5000)
      const updated = tracker.addParticipant(session.sessionId, 'a')

      expect(updated?.lastActivityAt).toBeGreaterThan(createdActivityAt)
      vi.useRealTimers()
    })

    it('returns null for an unknown sessionId', () => {
      expect(tracker.addParticipant('does-not-exist', 'a')).toBeNull()
    })

    it('throws when adding a genuinely new participant would exceed the cap', () => {
      const atMax = Array.from(
        { length: COLLABORATIVE_SESSION_CONFIG.MAX_PARTICIPANTS_PER_SESSION },
        (_, i) => `agent-${i}`
      )
      const session = tracker.create({ participantKeyIds: atMax })

      expect(() => tracker.addParticipant(session.sessionId, 'one-too-many')).toThrow(
        'collaborative_session_too_many_participants'
      )
    })

    it('does not throw when re-adding an existing participant at the cap', () => {
      const atMax = Array.from(
        { length: COLLABORATIVE_SESSION_CONFIG.MAX_PARTICIPANTS_PER_SESSION },
        (_, i) => `agent-${i}`
      )
      const session = tracker.create({ participantKeyIds: atMax })

      expect(() => tracker.addParticipant(session.sessionId, 'agent-0')).not.toThrow()
    })
  })

  describe('touch', () => {
    it('bumps lastActivityAt without changing participants', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      const session = tracker.create({ participantKeyIds: ['a', 'b'] })
      vi.advanceTimersByTime(10000)

      const touched = tracker.touch(session.sessionId)
      expect(touched?.lastActivityAt).toBeGreaterThan(session.createdAt)
      expect(touched?.participantKeyIds).toEqual(['a', 'b'])

      vi.useRealTimers()
    })

    it('returns null for an unknown sessionId', () => {
      expect(tracker.touch('does-not-exist')).toBeNull()
    })

    it('does not change createdAt', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      const session = tracker.create({ participantKeyIds: ['a'] })
      vi.advanceTimersByTime(5000)
      const touched = tracker.touch(session.sessionId)

      expect(touched?.createdAt).toBe(session.createdAt)
      vi.useRealTimers()
    })
  })

  describe('findByParticipants', () => {
    it('finds a session containing both given keyIds', () => {
      const session = tracker.create({ participantKeyIds: ['a', 'b', 'c'] })
      expect(tracker.findByParticipants('a', 'b')?.sessionId).toBe(session.sessionId)
    })

    it('returns null when no session contains both keyIds', () => {
      tracker.create({ participantKeyIds: ['a', 'b'] })
      expect(tracker.findByParticipants('a', 'z')).toBeNull()
    })

    it('is order-independent for the pair', () => {
      const session = tracker.create({ participantKeyIds: ['a', 'b'] })
      expect(tracker.findByParticipants('b', 'a')?.sessionId).toBe(session.sessionId)
    })

    it('returns the most-recently-active session when multiple contain the pair', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      const older = tracker.create({ participantKeyIds: ['a', 'b'] })
      vi.advanceTimersByTime(1000)
      const newer = tracker.create({ participantKeyIds: ['a', 'b'] })
      vi.advanceTimersByTime(1000)
      // Touch the older one to make it the most recently active instead.
      tracker.touch(older.sessionId)

      const found = tracker.findByParticipants('a', 'b')
      expect(found?.sessionId).toBe(older.sessionId)
      expect(newer.sessionId).not.toBe(older.sessionId)

      vi.useRealTimers()
    })
  })

  describe('clear', () => {
    it('removes all sessions', () => {
      tracker.create({ participantKeyIds: ['a', 'b'] })
      tracker.create({ participantKeyIds: ['c', 'd'] })

      tracker.clear()

      expect(tracker.list().sessions).toHaveLength(0)
    })
  })
})
