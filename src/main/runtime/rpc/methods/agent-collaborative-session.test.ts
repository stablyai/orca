/**
 * Unit tests for Collaborative Session RPC methods (P2-1)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  CollaborativeSessionTracker,
  setGlobalCollaborativeSessionTracker
} from '../../agent-collaborative-session'
import { AGENT_COLLABORATIVE_SESSION_METHODS } from './agent-collaborative-session'
import { InvalidArgumentError } from '../core'

describe('Collaborative Session RPC Methods', () => {
  let tracker: CollaborativeSessionTracker
  let createHandler: unknown
  let getHandler: unknown
  let listHandler: unknown

  beforeEach(() => {
    tracker = new CollaborativeSessionTracker()
    setGlobalCollaborativeSessionTracker(tracker)

    createHandler = AGENT_COLLABORATIVE_SESSION_METHODS.find(
      (m) => m.name === 'agent.collabSession.create'
    )?.handler
    getHandler = AGENT_COLLABORATIVE_SESSION_METHODS.find(
      (m) => m.name === 'agent.collabSession.get'
    )?.handler
    listHandler = AGENT_COLLABORATIVE_SESSION_METHODS.find(
      (m) => m.name === 'agent.collabSession.list'
    )?.handler
  })

  afterEach(() => {
    tracker.clear()
    setGlobalCollaborativeSessionTracker(null)
  })

  describe('agent.collabSession.create', () => {
    it('creates a session via RPC', () => {
      const handler = createHandler as (params: unknown) => unknown
      const result = handler({ participantKeyIds: ['codex-1', 'pi-1'] }) as any

      expect(result.sessionId).toBeTruthy()
      expect(result.participantKeyIds).toEqual(['codex-1', 'pi-1'])
      expect(result.createdAt).toBeGreaterThan(0)
    })

    it('includes metadata when provided', () => {
      const handler = createHandler as (params: unknown) => unknown
      const result = handler({
        participantKeyIds: ['codex-1', 'pi-1'],
        metadata: { label: 'test-session' }
      }) as any

      expect(result.metadata).toEqual({ label: 'test-session' })
    })

    it('translates the too-few-participants tracker error into InvalidArgumentError', () => {
      const handler = createHandler as (params: unknown) => unknown
      expect(() => handler({ participantKeyIds: [] })).toThrow(InvalidArgumentError)
    })

    it('translates the too-many-participants tracker error into InvalidArgumentError', () => {
      const handler = createHandler as (params: unknown) => unknown
      const tooMany = Array.from({ length: 40 }, (_, i) => `agent-${i}`)
      expect(() => handler({ participantKeyIds: tooMany })).toThrow(InvalidArgumentError)
    })
  })

  describe('agent.collabSession.get', () => {
    it('fetches a created session by sessionId', () => {
      const created = (createHandler as (params: unknown) => any)({
        participantKeyIds: ['a', 'b']
      })

      const handler = getHandler as (params: unknown) => unknown
      const result = handler({ sessionId: created.sessionId }) as any
      expect(result.sessionId).toBe(created.sessionId)
    })

    it('returns null for an unknown sessionId', () => {
      const handler = getHandler as (params: unknown) => unknown
      const result = handler({ sessionId: 'does-not-exist' })
      expect(result).toBeNull()
    })
  })

  describe('agent.collabSession.list', () => {
    beforeEach(() => {
      const handler = createHandler as (params: unknown) => unknown
      handler({ participantKeyIds: ['a', 'b'] })
      handler({ participantKeyIds: ['c', 'd'] })
    })

    it('lists all sessions when no filter provided', () => {
      const handler = listHandler as (params: unknown) => unknown
      const result = handler({}) as any
      expect(result.sessions).toHaveLength(2)
      expect(result.totalCount).toBe(2)
    })

    it('filters by participantKeyId', () => {
      const handler = listHandler as (params: unknown) => unknown
      const result = handler({ participantKeyId: 'a' }) as any
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0].participantKeyIds).toContain('a')
    })

    it('returns empty for a non-matching participantKeyId', () => {
      const handler = listHandler as (params: unknown) => unknown
      const result = handler({ participantKeyId: 'nonexistent' }) as any
      expect(result.sessions).toHaveLength(0)
      expect(result.totalCount).toBe(2)
    })
  })

  describe('integration: create -> get -> list', () => {
    it('a session created via RPC is immediately visible via get and list', () => {
      const created = (createHandler as (params: unknown) => any)({
        participantKeyIds: ['codex-1', 'pi-1']
      })

      const fetched = (getHandler as (params: unknown) => any)({ sessionId: created.sessionId })
      expect(fetched.sessionId).toBe(created.sessionId)

      const listed = (listHandler as (params: unknown) => any)({ participantKeyId: 'codex-1' })
      expect(listed.sessions.map((s: any) => s.sessionId)).toContain(created.sessionId)
    })
  })
})
