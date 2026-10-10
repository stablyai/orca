// Resolve the host launch identity, then commit an at-rest create or the compatible acquired path.

import { refuse, AgentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../../shared/agent-session-wire'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type {
  StructuredAgentSessionResumeSource,
  StructuredAgentSessionFirstMessage
} from '../../../../shared/structured-agent-session-create'
import { structuredAgentSessionOptionOverridesRefusal } from '../../../native-chat/agent-session-wire/structured-agent-session-options-read'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { StructuredAgentId } from '../../../../shared/agent-session-provider-handle'
import {
  resolveUncommittedStructuredCreate,
  type StructuredCreateRefused
} from './structured-agent-session-precommit-refusal'

export type PreparedStructuredAgentSessionCreate = {
  host: StructuredAgentSessionHost
  attachParams: AgentSessionAttachParams
  hostLaunchDirectory?: string
  /** Null when the caller supplied its own location; only a resolved worktree publishes a tab. */
  tab: { workspaceId: string; agent: StructuredAgentId } | null
  /** Absent for older clients and provider-dependent in-process callers. */
  atRest?: { firstMessage?: StructuredAgentSessionFirstMessage }
}

/** New creates keep the immutable client intent in the ledger; legacy creates keep attach identity. */
export function structuredAgentSessionCreateIntentFingerprint(params: {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: string
  resumeFrom?: StructuredAgentSessionResumeSource
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  options?: Readonly<Record<string, string>>
}): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.create',
    sessionId: params.envelope.sessionId,
    fields: {
      worktree: params.worktree,
      agent: params.agent,
      resumeFrom: params.resumeFrom,
      tabId: params.tabId,
      firstMessage: params.firstMessage,
      options: params.options
    }
  })
}

/** The pre-commit half. Throws; the caller is expected to run it inside
 *  `resolveUncommittedStructuredCreate` so a failure reaches the client as a refusal. */
export async function prepareStructuredAgentSessionCreateForWorktree(args: {
  runtime: OrcaRuntimeService
  /** Installs the host lazily; called at the same point the RPC handler always installed it. */
  ensureHost: () => Promise<StructuredAgentSessionHost>
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: StructuredAgentId
  caller: StructuredAgentSessionCaller
  resumeFrom?: StructuredAgentSessionResumeSource
  /** Explicit picks override seed keys at rest; acquired in-process launches replace the seed. */
  options?: Readonly<Record<string, string>>
  /** The tab id the caller reserved for this chat, taken when its tab is published; absent, the tab
   *  gets the id clients derive. Beside `options`, after the fingerprint, likewise. */
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  atRest?: boolean
}): Promise<PreparedStructuredAgentSessionCreate> {
  // Adoption replay may need the record loaded from disk before source discovery can be skipped.
  let host = args.resumeFrom ? await args.ensureHost() : null
  const resolved = await args.runtime.resolveStructuredAgentSessionCreateIntent({
    envelope: args.envelope,
    worktree: args.worktree,
    agent: args.agent,
    callerKey: args.caller.callerKey,
    ...(args.resumeFrom ? { resumeFrom: args.resumeFrom } : {})
  })
  const attachFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId: args.envelope.sessionId,
    fields: attachFingerprintFields({ ...resolved, envelope: args.envelope })
  })
  host ??= await args.ensureHost()
  const priorOperation =
    args.atRest === undefined
      ? null
      : host.deps.store.getOperationRow(args.caller.callerKey, args.envelope.clientOperationId)
  // A capability update cannot change the contract of an already-recorded create.
  const legacyReplay =
    args.firstMessage === undefined &&
    args.options === undefined &&
    priorOperation?.fingerprint === attachFingerprint
  const atRest =
    args.atRest !== undefined &&
    (priorOperation?.fingerprint === args.envelope.payloadFingerprint ||
      (args.atRest === true && !legacyReplay))
  const hostFingerprint = atRest ? args.envelope.payloadFingerprint : attachFingerprint
  if (atRest && args.options) {
    const refusal = structuredAgentSessionOptionOverridesRefusal(
      host.deps.agents,
      args.agent,
      args.options
    )
    if (refusal) {
      throw new AgentSessionRefusalError(refusal)
    }
  }
  const {
    agent: _resolvedAgent,
    provider: _resolvedProvider,
    hostLaunchDirectory,
    ...resolvedAttach
  } = resolved
  return {
    host,
    ...(hostLaunchDirectory ? { hostLaunchDirectory } : {}),
    attachParams: {
      ...resolvedAttach,
      // The ledger covers explicit overrides, never defaults that settings can change on replay.
      ...(args.options
        ? { options: atRest ? { ...resolved.options, ...args.options } : args.options }
        : {}),
      ...(args.tabId ? { surfaceTabId: args.tabId } : {}),
      provider: resolved.provider,
      agent: resolved.agent,
      envelope: { ...args.envelope, payloadFingerprint: hostFingerprint }
    },
    ...(atRest ? { atRest: args.firstMessage ? { firstMessage: args.firstMessage } : {} } : {}),
    tab: {
      workspaceId: resolved.location.workspaceId,
      agent: resolved.agent
    }
  }
}

/** The commit half. Past `attach`, a failure no longer proves the session does not exist. */
export async function commitStructuredAgentSessionCreate(args: {
  runtime: OrcaRuntimeService
  caller: StructuredAgentSessionCaller
  prepared: PreparedStructuredAgentSessionCreate
  activate: boolean
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { prepared } = args
  const tab = prepared.tab
  if (prepared.atRest) {
    return prepared.host.create(args.caller, prepared.attachParams, {
      ...prepared.atRest,
      ...(prepared.hostLaunchDirectory
        ? { hostLaunchDirectory: prepared.hostLaunchDirectory }
        : {}),
      ...(tab
        ? {
            publishTab: () =>
              args.runtime.publishStructuredAgentSessionTab({
                workspaceId: tab.workspaceId,
                sessionId: prepared.attachParams.envelope.sessionId,
                agent: tab.agent,
                activate: args.activate,
                ...(prepared.attachParams.surfaceTabId
                  ? { tabId: prepared.attachParams.surfaceTabId }
                  : {})
              })
          }
        : {})
    })
  }
  const result = prepared.hostLaunchDirectory
    ? await prepared.host.attach(args.caller, prepared.attachParams, {
        hostLaunchDirectory: prepared.hostLaunchDirectory
      })
    : await prepared.host.attach(args.caller, prepared.attachParams)
  if (!result.ok || !prepared.tab) {
    return result
  }
  const surfaceTabId = prepared.attachParams.surfaceTabId
  try {
    await args.runtime.publishStructuredAgentSessionTab({
      workspaceId: prepared.tab.workspaceId,
      sessionId: result.value.sessionId,
      agent: prepared.tab.agent,
      activate: args.activate,
      ...(surfaceTabId ? { tabId: surfaceTabId } : {})
    })
  } catch (error) {
    prepared.host.deps.logger.warn('publishing the tab of a created chat failed', {
      scope: 'create-tab-publication',
      sessionId: result.value.sessionId,
      error
    })
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_unknown',
        { reason: 'tabUnconfirmed' },
        'The chat may have been created, but its tab could not be confirmed.'
      )
    }
  }
  // Read after publishing, which is what gives the chat its tab.
  const tabId = prepared.host.getSessionTabId?.(result.value.sessionId)
  return tabId ? { ...result, value: { ...result.value, tabId } } : result
}

export async function createStructuredAgentSessionForWorktree(args: {
  runtime: OrcaRuntimeService
  ensureHost: () => Promise<StructuredAgentSessionHost>
  caller: StructuredAgentSessionCaller
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: StructuredAgentId
  activate: boolean
  options?: Readonly<Record<string, string>>
  tabId?: string
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const prepared: PreparedStructuredAgentSessionCreate | StructuredCreateRefused =
    await resolveUncommittedStructuredCreate(() =>
      prepareStructuredAgentSessionCreateForWorktree(args)
    )
  if ('refusal' in prepared) {
    return { ok: false, refusal: prepared.refusal }
  }
  return commitStructuredAgentSessionCreate({
    runtime: args.runtime,
    caller: args.caller,
    prepared,
    activate: args.activate
  })
}
