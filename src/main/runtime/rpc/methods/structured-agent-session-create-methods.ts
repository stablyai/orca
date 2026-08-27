import type { z } from 'zod'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../../shared/agent-session-mutation-envelope'
import { defineMethod, type RpcAnyMethod, type RpcContext } from '../core'
import {
  canAccessWorkItemStartStructuredSession,
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredCreateHost,
  requireStructuredHost,
  structuredCallerFor,
  supportsStructuredSessions
} from './structured-agent-session-gate'
import {
  commitStructuredAgentSessionCreate,
  prepareStructuredAgentSessionCreateForWorktree
} from './structured-agent-session-create'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'
import { supportsWorkItemStartStructuredSessionCreate } from './structured-agent-session-policy'
import { AttachParams, CreateParams, CreateSupportParams } from './structured-agent-session-schemas'

/** Direct attach is host-measured because the client-supplied location skips worktree resolution. */
async function resolveClientSuppliedAttach(params: z.infer<typeof AttachParams>, ctx: RpcContext) {
  await ensureStructuredHostInstalled(ctx)
  const host = requireStructuredHost(ctx)
  if (!host.supportsCreate(params.location, params.agent)) {
    throw new Error('structured_agent_session_unsupported')
  }
  const { agent: _attachAgent, provider: _attachProvider, ...attachWithoutAgent } = params
  const attachParams = {
    ...attachWithoutAgent,
    provider: params.provider as 'claude' | 'codex',
    agent: params.agent as 'claude' | 'codex'
  } as AgentSessionAttachParams
  return { host, attachParams }
}

async function attachClientSuppliedLocation(
  params: z.infer<typeof AttachParams>,
  ctx: RpcContext
): Promise<unknown> {
  const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
  return host.attach(structuredCallerFor(ctx), attachParams)
}

export const STRUCTURED_AGENT_SESSION_CREATE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'agentSession.createSupport',
    params: CreateSupportParams,
    handler: async (params, ctx) => {
      if (params.launchOrigin && params.sessionId) {
        await ensureStructuredHostInstalled(ctx, {
          sessionId: params.sessionId,
          launchOrigin: params.launchOrigin
        })
      }
      const reconcilesDurableSession =
        params.launchOrigin === 'work-item-start' &&
        params.sessionId !== undefined &&
        canAccessWorkItemStartStructuredSession(ctx, params.sessionId)
      const admitted = params.launchOrigin
        ? supportsWorkItemStartStructuredSessionCreate(ctx, params.launchOrigin) ||
          reconcilesDurableSession
        : supportsStructuredSessions(ctx)
      if (!admitted) {
        throw new Error('structured_agent_session_unsupported')
      }
      if (reconcilesDurableSession) {
        return { supported: true }
      }
      return ctx.runtime.getStructuredAgentSessionCreateSupport(params.worktree, params.agent)
    }
  }),
  defineMethod({
    name: 'agentSession.create',
    params: CreateParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      const launchOrigin = 'worktree' in params ? params.launchOrigin : undefined
      if (launchOrigin) {
        await ensureStructuredHostInstalled(ctx, {
          sessionId: params.envelope.sessionId,
          launchOrigin
        })
      }
      const admitted = launchOrigin
        ? supportsWorkItemStartStructuredSessionCreate(ctx, launchOrigin) ||
          canAccessWorkItemStartStructuredSession(ctx, params.envelope.sessionId)
        : supportsStructuredSessions(ctx)
      if (!admitted) {
        throw new Error('structured_agent_session_unsupported')
      }
      if (params.envelope.expectedRuntimeFence !== null) {
        throw new Error('agent_session_operation_invalid')
      }
      const prepared = await resolveUncommittedStructuredCreate(async () => {
        if ('worktree' in params) {
          const intentFingerprint = computeAgentSessionPayloadFingerprint({
            method: 'agentSession.create',
            sessionId: params.envelope.sessionId,
            fields: {
              worktree: params.worktree,
              agent: params.agent,
              resumeFrom: params.resumeFrom,
              launchOrigin: params.launchOrigin
            }
          })
          const conflict = agentSessionFingerprintConflict(params.envelope, intentFingerprint)
          if (conflict) {
            return { refusal: conflict }
          }
          return prepareStructuredAgentSessionCreateForWorktree({
            runtime: ctx.runtime,
            ensureHost: async () => {
              await ensureStructuredHostInstalled(ctx, {
                sessionId: params.envelope.sessionId,
                launchOrigin: params.launchOrigin
              })
              return requireStructuredCreateHost(
                ctx,
                params.launchOrigin,
                params.envelope.sessionId
              )
            },
            envelope: params.envelope,
            worktree: params.worktree,
            agent: params.agent as 'claude' | 'codex',
            caller: structuredCallerFor(ctx),
            ...(params.resumeFrom ? { resumeFrom: params.resumeFrom } : {}),
            ...(params.launchOrigin ? { launchOrigin: params.launchOrigin } : {})
          })
        }
        const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
        return { host, attachParams, tab: null }
      })
      if ('refusal' in prepared) {
        return { ok: false, refusal: prepared.refusal }
      }
      return commitStructuredAgentSessionCreate({
        runtime: ctx.runtime,
        caller: structuredCallerFor(ctx),
        prepared,
        activate: true
      })
    }
  }),
  defineMethod({
    name: 'agentSession.ensure',
    params: AttachParams,
    handler: async (params, ctx) => attachClientSuppliedLocation(params, ctx)
  })
]
