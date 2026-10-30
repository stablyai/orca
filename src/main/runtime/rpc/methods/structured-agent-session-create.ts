import { seededPermissionMode } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
// Resolve the host launch identity, then commit an at-rest create or the compatible acquired path.

import { assertAgentPromptRequestActive } from '../../orca-runtime-core'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
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
import type { StructuredAgentSessionCreateOptions } from '../../../native-chat/agent-session-wire/structured-agent-session-create'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  captureStructuredAgentCliSource,
  type StructuredAgentCliSourceEvidence
} from '../../../native-chat/structured-agent-cli-source'
import type { StructuredAgentId } from '../../../../shared/agent-session-provider-handle'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { structuredAgentSessionClosedBeforeCreate } from './structured-agent-session-close-before-create'
import type { ChatTabPlacement } from '../../agent-session/agent-session-tab-layout'

export type PreparedStructuredAgentSessionCreate = {
  host: StructuredAgentSessionHost
  attachParams: AgentSessionAttachParams
  hostLaunchDirectory?: string
  catalogModels?: StructuredAgentSessionCreateOptions['catalogModels']
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
  optionsMode?: 'replace-model-selection'
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
      optionsMode: params.optionsMode,
      options: params.options
    }
  })
}

/** Run throwing pre-commit work inside resolveUncommittedStructuredCreate so clients receive a no-effects refusal. */
export async function prepareStructuredAgentSessionCreateForWorktree(args: {
  runtime: OrcaRuntimeService
  /** Installs the host lazily; called at the same point the RPC handler always installed it. */
  ensureHost: () => Promise<StructuredAgentSessionHost>
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: StructuredAgentId
  caller: StructuredAgentSessionCaller
  resumeFrom?: StructuredAgentSessionResumeSource
  structuredAgentCliSourceEvidence?: StructuredAgentCliSourceEvidence
  /** Explicit picks override seed keys at rest; acquired in-process launches replace the seed. */
  optionsMode?: 'replace-model-selection'
  options?: Readonly<Record<string, string>>
  /** Use the caller-reserved tab id at publication; absent, derive the legacy id. Keep it outside launch fingerprints. */
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  atRest?: boolean
}): Promise<PreparedStructuredAgentSessionCreate> {
  const structuredAgentCliSourceEvidence =
    args.structuredAgentCliSourceEvidence ??
    (args.resumeFrom?.cliSource
      ? captureStructuredAgentCliSource(
          () => args.runtime.getAgentProviderSessionRows(),
          args.resumeFrom.cliSource,
          (source) => args.runtime.getStructuredAgentCliSourceRoute(source)
        )
      : undefined)
  // Adoption replay may need the record loaded from disk before source discovery can be skipped.
  let host = args.resumeFrom ? await args.ensureHost() : null
  const resolved = await args.runtime.resolveStructuredAgentSessionCreateIntent({
    envelope: args.envelope,
    worktree: args.worktree,
    agent: args.agent,
    callerKey: args.caller.callerKey,
    structuredAgentCliSourceEvidence,
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
  const { agent: _agent, provider: _provider, hostLaunchDirectory, ...resolvedAttach } = resolved
  // Fingerprint explicit picks, never replay-varying defaults; explicit options replace saved seeds, while permission default stays chat-owned.
  const overlays = atRest
    ? args.optionsMode !== 'replace-model-selection'
    : Object.keys(args.options ?? {}).every((id) => id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
  const picked = args.options
    ? overlays
      ? { ...resolved.options, ...args.options }
      : { ...seededPermissionMode(resolved.options), ...args.options }
    : resolved.options
  return {
    host,
    ...(hostLaunchDirectory ? { hostLaunchDirectory } : {}),
    attachParams: {
      ...resolvedAttach,
      ...(picked ? { options: picked } : {}),
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
  /** This machine's window made the create and opens the chat's tab where it reserved it. */
  placedByWindow?: boolean
  /** Where the creating client opens the chat, in this host's ids. */
  tabPlacement?: ChatTabPlacement
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { prepared } = args
  const tab = prepared.tab
  const tabPlace = {
    ...(args.placedByWindow ? { placedByWindow: true } : {}),
    ...(args.tabPlacement ? { placement: args.tabPlacement } : {})
  }
  if (prepared.atRest) {
    return prepared.host.create(args.caller, prepared.attachParams, {
      ...prepared.atRest,
      ...(prepared.catalogModels ? { catalogModels: prepared.catalogModels } : {}),
      ...(prepared.hostLaunchDirectory
        ? { hostLaunchDirectory: prepared.hostLaunchDirectory }
        : {}),
      ...(tab
        ? {
            // A chat closed while it was being made gets no tab to show before main closes it.
            publishTab: () =>
              ORCA_LAYOUT_OWNER_IS_MAIN &&
              structuredAgentSessionClosedBeforeCreate(prepared.attachParams.envelope.sessionId)
                ? Promise.resolve()
                : args.runtime.publishStructuredAgentSessionTab({
                    workspaceId: tab.workspaceId,
                    sessionId: prepared.attachParams.envelope.sessionId,
                    agent: tab.agent,
                    activate: args.activate,
                    ...tabPlace,
                    ...(prepared.attachParams.surfaceTabId
                      ? { tabId: prepared.attachParams.surfaceTabId }
                      : {})
                  })
          }
        : {})
    })
  }
  const result = await prepared.host.attach(args.caller, prepared.attachParams, {
    ...(prepared.hostLaunchDirectory ? { hostLaunchDirectory: prepared.hostLaunchDirectory } : {}),
    ...(prepared.catalogModels ? { catalogModels: prepared.catalogModels } : {})
  })
  if (!result.ok || !prepared.tab) {
    return result
  }
  // A chat closed while it was being made gets no tab to show before main closes it.
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    structuredAgentSessionClosedBeforeCreate(result.value.sessionId)
  ) {
    return result
  }
  const surfaceTabId = prepared.attachParams.surfaceTabId
  try {
    await args.runtime.publishStructuredAgentSessionTab({
      workspaceId: prepared.tab.workspaceId,
      sessionId: result.value.sessionId,
      agent: prepared.tab.agent,
      activate: args.activate,
      ...tabPlace,
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
  optionsMode?: 'replace-model-selection'
  options?: Readonly<Record<string, string>>
  tabId?: string
  /** Create without starting the agent; its first message starts it. */
  atRest?: true
  firstMessage?: StructuredAgentSessionFirstMessage
  signal?: AbortSignal
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  // An at-rest create's ledger row is keyed by its intent, as a client's create is.
  const envelope = args.atRest
    ? {
        ...args.envelope,
        payloadFingerprint: structuredAgentSessionCreateIntentFingerprint(args)
      }
    : args.envelope
  const prepared = await resolveUncommittedStructuredCreate(() =>
    prepareStructuredAgentSessionCreateForWorktree({ ...args, envelope })
  )
  if ('refusal' in prepared) {
    return { ok: false, refusal: prepared.refusal }
  }
  assertAgentPromptRequestActive(args.signal)
  return commitStructuredAgentSessionCreate({
    runtime: args.runtime,
    caller: args.caller,
    prepared,
    activate: args.activate
  })
}
