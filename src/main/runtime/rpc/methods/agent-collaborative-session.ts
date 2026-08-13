/**
 * RPC Methods for Collaborative Session Tracking (P2-1)
 *
 * Provides the following RPC endpoints:
 * - agent.collabSession.create: Create a session with initial participants
 * - agent.collabSession.get: Fetch a single session by sessionId
 * - agent.collabSession.list: Query sessions, optionally filtered by
 *   participant keyId
 *
 * Namespace note: 'agent.collabSession.*', not 'agent.session.*' — see the
 * naming note at the top of src/shared/agent-collaborative-session.ts for
 * why this avoids the name already used by the unrelated PTY-backed
 * "agent session" concept (terminal.ensureAgentSession /
 * terminal.createAgentSession in ./agent-session.ts).
 */

import { z } from 'zod'
import type {
  CollaborativeSessionListOptions,
  CollaborativeSessionListResult
} from '../../../../shared/agent-collaborative-session'
import { getGlobalCollaborativeSessionTracker } from '../../agent-collaborative-session'
import { defineMethod, InvalidArgumentError, type RpcAnyMethod } from '../core'

// ============================================================================
// Zod Schemas for Request/Response Validation
// ============================================================================

const KeyIdSchema = z.string().min(1).max(256)

const CreateParamsSchema = z.object({
  participantKeyIds: z.array(KeyIdSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).optional()
})

const GetParamsSchema = z.object({
  sessionId: z.string().min(1).max(256)
})

const ListParamsSchema = z.object({
  participantKeyId: KeyIdSchema.optional()
})

// ============================================================================
// RPC Method Handlers
// ============================================================================

/**
 * agent.collabSession.create
 * Create a new collaborative session grouping the given participant keyIds.
 * Translates the tracker's thrown, malformed-request errors
 * ('collaborative_session_too_few_participants' /
 * '...too_many_participants') into InvalidArgumentError, matching how other
 * RPC handlers in this codebase surface a caller-error distinctly from an
 * unexpected server fault.
 */
const createMethod = defineMethod({
  name: 'agent.collabSession.create',
  params: CreateParamsSchema,
  handler: (params) => {
    const tracker = getGlobalCollaborativeSessionTracker()
    try {
      return tracker.create({
        participantKeyIds: params.participantKeyIds,
        metadata: params.metadata
      })
    } catch (error) {
      if (error instanceof Error) {
        throw new InvalidArgumentError(error.message)
      }
      throw error
    }
  }
})

/**
 * agent.collabSession.get
 * Fetch a single session by sessionId. Returns null if not found.
 */
const getMethod = defineMethod({
  name: 'agent.collabSession.get',
  params: GetParamsSchema,
  handler: (params) => {
    const tracker = getGlobalCollaborativeSessionTracker()
    return tracker.get(params.sessionId)
  }
})

/**
 * agent.collabSession.list
 * List all sessions, optionally filtered by participant keyId.
 */
const listMethod = defineMethod({
  name: 'agent.collabSession.list',
  params: ListParamsSchema,
  handler: (params): CollaborativeSessionListResult => {
    const tracker = getGlobalCollaborativeSessionTracker()
    const options: CollaborativeSessionListOptions = {}

    if (params.participantKeyId) {
      options.participantKeyId = params.participantKeyId
    }

    return tracker.list(options)
  }
})

/**
 * Export all collaborative session RPC methods.
 */
export const AGENT_COLLABORATIVE_SESSION_METHODS: RpcAnyMethod[] = [
  createMethod,
  getMethod,
  listMethod
]
