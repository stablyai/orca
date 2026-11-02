import {
  awaitRequiredSetup,
  AgentLaunchSetupNotCompletedError,
  type SetupRun
} from '../../setup/setup-run'
import type { StructuredSessionSurface } from '../../agent-session/structured-agent-session-close'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
import type { z } from 'zod'
import {
  agentSessionRefusalError,
  refuseUnclassified,
  type AgentSessionWireRefusal
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionFingerprintConflict } from '../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-create-capabilities'
import type { RpcContext } from '../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredHost as requireHost,
  requireStructuredAgentAudience,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { AttachParams, CreateParams } from './structured-agent-session-schemas'
import {
  commitStructuredAgentSessionCreate,
  prepareStructuredAgentSessionCreateForWorktree,
  structuredAgentSessionCreateIntentFingerprint
} from './structured-agent-session-create'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'
import {
  structuredAgentSessionClosedBeforeCreate,
  subscribeStructuredAgentSessionClose,
  structuredAgentSessionClosedBeforeCreateRefusal
} from './structured-agent-session-close-before-create'

/** Attach-shaped requests bypass workspace create-support; ask the execution host directly so client-supplied locations cannot forge support. */
async function resolveClientSuppliedAttach(params: z.infer<typeof AttachParams>, ctx: RpcContext) {
  await ensureHostInstalled(ctx, params.agent)
  const host = requireHost(ctx, params.agent)
  if (!host.supportsCreate(params.location, params.agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  // Reservation applies options only to a record it creates, so an existing chat is never reseeded.
  const permissionMode = ctx.runtime.structuredAgentSessionLaunchSeedOptions(params.agent)?.[
    AGENT_CHAT_PERMISSION_MODE_OPTION_ID
  ]
  const attachParams: AgentSessionAttachParams = {
    ...params,
    ...(permissionMode
      ? { options: { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permissionMode } }
      : {})
  }
  return { host, attachParams }
}

export async function attachClientSuppliedLocation(
  params: z.infer<typeof AttachParams>,
  ctx: RpcContext
): Promise<unknown> {
  const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
  return host.attach(callerFor(ctx), attachParams)
}

export async function handleStructuredAgentSessionCreate(
  params: z.infer<typeof CreateParams>,
  ctx: RpcContext,
  capture?: (surface: StructuredSessionSurface) => void
) {
  requireStructuredAgentAudience(ctx, params.agent)
  if (params.envelope.expectedRuntimeFence !== null) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  // Native support is decided after the linked setup succeeds, so a refusal past here may open a terminal.
  if ('worktree' in params && params.afterWorktreeSetup) {
    const refusal = await awaitLinkedCreateSetup(params, ctx)
    if (refusal) {
      return { ok: false, refusal }
    }
  }
  // Before attach, return refusals instead of throwing so clients can distinguish no effects from unknown outcomes.
  const prepared = await resolveUncommittedStructuredCreate(async () => {
    if ('worktree' in params) {
      const conflict = agentSessionFingerprintConflict(
        params.envelope,
        structuredAgentSessionCreateIntentFingerprint(params)
      )
      if (conflict) {
        return { refusal: conflict }
      }
      return prepareStructuredAgentSessionCreateForWorktree({
        runtime: ctx.runtime,
        ensureHost: async () => {
          await ensureHostInstalled(ctx)
          return requireHost(ctx)
        },
        envelope: params.envelope,
        worktree: params.worktree,
        agent: params.agent,
        caller: callerFor(ctx),
        structuredAgentCliSourceEvidence: ctx.structuredAgentCliSourceEvidence,
        ...(params.resumeFrom ? { resumeFrom: params.resumeFrom } : {}),
        ...(params.tabId ? { tabId: params.tabId } : {}),
        ...(params.optionsMode ? { optionsMode: params.optionsMode } : {}),
        ...(params.options ? { options: params.options } : {}),
        ...(params.firstMessage ? { firstMessage: params.firstMessage } : {}),
        atRest: Boolean(
          params.firstMessage ||
          ctx.clientCapabilities?.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)
        )
      })
    }
    const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
    return { host, attachParams, tab: null }
  })
  if ('refusal' in prepared) {
    return { ok: false, refusal: prepared.refusal }
  }
  // Nothing is created yet, so a close that came first refuses the create outright.
  if (structuredAgentSessionClosedBeforeCreate(params.envelope.sessionId)) {
    return { ok: false, refusal: structuredAgentSessionClosedBeforeCreateRefusal() }
  }
  return commitStructuredAgentSessionCreate({
    runtime: ctx.runtime,
    caller: callerFor(ctx),
    prepared,
    activate: true,
    placedByWindow: ctx.caller?.kind === 'desktop',
    ...(capture ? { capture } : {}),
    ...('tabPlacement' in params && params.tabPlacement
      ? { tabPlacement: params.tabPlacement }
      : {})
  })
}

/** A create linked to its workspace's required setup waits for that exact run before native
 *  preparation; an operation this host already admitted is a replay and its ledger answers. */
async function awaitLinkedCreateSetup(
  params: z.infer<typeof CreateParams> & { worktree: string },
  ctx: RpcContext
): Promise<AgentSessionWireRefusal | null> {
  const setupNotCompleted = (error: AgentLaunchSetupNotCompletedError) =>
    refuseUnclassified('agent_session_setup_not_completed', error.message)
  let run: SetupRun | undefined
  try {
    await ensureHostInstalled(ctx)
    if (
      requireHost(ctx).deps.store.getOperationRow(
        callerFor(ctx).callerKey,
        params.envelope.clientOperationId
      )
    ) {
      return null
    }
    run = ctx.runtime.getSetupRun(
      (await ctx.runtime.resolveRuntimeFileTarget(params.worktree)).worktree.id
    )
  } catch (error) {
    // Nothing before setup may read as a native refusal, which would permit a terminal.
    console.warn('[agent-session] linked create could not find its setup', error)
  }
  if (!run) {
    return setupNotCompleted(
      new AgentLaunchSetupNotCompletedError(
        { kind: 'ended', reason: 'observation_lost' },
        params.agent
      )
    )
  }
  const closed = new AbortController()
  const unsubscribe = subscribeStructuredAgentSessionClose(params.envelope.sessionId, () =>
    closed.abort()
  )
  try {
    if (structuredAgentSessionClosedBeforeCreate(params.envelope.sessionId)) {
      return structuredAgentSessionClosedBeforeCreateRefusal()
    }
    await awaitRequiredSetup(
      run,
      params.agent,
      ctx.signal ? AbortSignal.any([ctx.signal, closed.signal]) : closed.signal
    )
    return null
  } catch (error) {
    if (closed.signal.aborted) {
      return structuredAgentSessionClosedBeforeCreateRefusal()
    }
    if (!(error instanceof AgentLaunchSetupNotCompletedError)) {
      throw error
    }
    return setupNotCompleted(error)
  } finally {
    unsubscribe()
  }
}
