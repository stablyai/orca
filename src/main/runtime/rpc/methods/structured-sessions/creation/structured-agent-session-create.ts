import { commitStructuredAgentSessionCreate } from './structured-agent-session-create-commit'
export { commitStructuredAgentSessionCreate } from './structured-agent-session-create-commit'
import {
  assertStructuredAgentEffortCommand,
  structuredAgentConfiguredArgs
} from '../../../../../native-chat/agent-launch/structured-agent-configured-args'
import { seededPermissionMode } from '../../../../../../shared/native-chat/input/session-options/native-chat-session-option-defaults'
// Resolve the host launch identity, then commit an at-rest create or the compatible acquired path.

import { assertAgentPromptRequestActive } from '../../../../terminal/input/agent-prompt-signals'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../../../shared/agent-launch/permissions/agent-chat-permission-mode-option-id'
import {
  agentSessionRefusalError,
  AgentSessionRefusalError
} from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { computeAgentSessionPayloadFingerprint } from '../../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../../../../shared/agent-session/agent-session-wire'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from '../../../../../native-chat/agent-session-wire/acquisition/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import type {
  StructuredAgentSessionResumeSource,
  StructuredAgentSessionFirstMessage
} from '../../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import '../../../../../native-chat/agent-session-wire/options/structured-agent-session-options-read'
import { structuredAgentSessionOptionOverridesRefusal } from '../../../../../native-chat/agent-session-wire/options/structured-agent-session-option-intent'
import type { StructuredAgentSessionCreateOptions } from '../../../../../native-chat/agent-session-wire/acquisition/structured-agent-session-create'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  captureStructuredAgentCliSource,
  type StructuredAgentCliSourceEvidence
} from '../../../../../native-chat/conversation-adoption/structured-agent-cli-source'
import type { StructuredAgentId } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'

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
  forkFrom?: { sessionId: string; throughItemId: string }
  resumeFrom?: StructuredAgentSessionResumeSource
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  omitEffort?: true
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
      forkFrom: params.forkFrom,
      tabId: params.tabId,
      firstMessage: params.firstMessage,
      optionsMode: params.optionsMode,
      options: params.options,
      omitEffort: params.omitEffort
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
  forkFrom?: { sessionId: string; throughItemId: string }
  resumeFrom?: StructuredAgentSessionResumeSource
  structuredAgentCliSourceEvidence?: StructuredAgentCliSourceEvidence
  omitEffort?: true
  /** Explicit picks override seed keys at rest; acquired in-process launches replace the seed. */
  optionsMode?: 'replace-model-selection'
  options?: Readonly<Record<string, string>>
  /** Use the caller-reserved tab id at publication; absent, derive the legacy id. Keep it outside launch fingerprints. */
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  atRest?: boolean
}): Promise<PreparedStructuredAgentSessionCreate> {
  const fork = args.forkFrom
  if (
    fork &&
    (args.resumeFrom || args.options || args.omitEffort || args.optionsMode || args.atRest !== true)
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
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
  let host = args.resumeFrom || args.forkFrom ? await args.ensureHost() : null
  const resolved = await args.runtime.resolveStructuredAgentSessionCreateIntent({
    envelope: args.envelope,
    worktree: args.worktree,
    agent: args.agent,
    callerKey: args.caller.callerKey,
    structuredAgentCliSourceEvidence,
    ...(args.resumeFrom ? { resumeFrom: args.resumeFrom } : {}),
    ...(args.forkFrom ? { forkFrom: args.forkFrom } : {})
  })
  const omitEffort =
    (args.omitEffort ?? resolved.omitEffort) && args.options?.effort === undefined
      ? true
      : undefined
  const attachFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId: args.envelope.sessionId,
    fields: attachFingerprintFields({
      ...resolved,
      ...(omitEffort ? { omitEffort } : {}),
      envelope: args.envelope
    })
  })
  host ??= await args.ensureHost()
  const priorOperation =
    args.atRest === undefined
      ? null
      : host.deps.store.getOperationRow(args.caller.callerKey, args.envelope.clientOperationId)
  if (omitEffort && priorOperation?.outcome.status !== 'succeeded') {
    const settings = args.runtime.requireStore().getSettings()
    assertStructuredAgentEffortCommand(args.agent, settings)
    if (args.agent === 'claude' || args.agent === 'codex') {
      structuredAgentConfiguredArgs(args.agent, settings, process.platform, true)
    }
  }
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
    agent: _agent,
    provider: _provider,
    omitEffort: _resolvedOmitEffort,
    hostLaunchDirectory,
    ...resolvedAttach
  } = resolved
  // Fingerprint explicit picks, never replay-varying defaults; explicit options replace saved seeds, while permission default stays chat-owned.
  const overlays = atRest
    ? args.optionsMode !== 'replace-model-selection'
    : Object.keys(args.options ?? {}).every((id) => id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
  const picked = args.options
    ? overlays
      ? { ...resolved.options, ...args.options }
      : { ...seededPermissionMode(resolved.options), ...args.options }
    : resolved.options
  const options = { ...picked }
  if (omitEffort) {
    delete options.effort
  }
  return {
    host,
    ...(hostLaunchDirectory ? { hostLaunchDirectory } : {}),
    attachParams: {
      ...resolvedAttach,
      ...(picked ? { options } : {}),
      ...(omitEffort ? { omitEffort } : {}),
      ...(args.tabId ? { surfaceTabId: args.tabId } : {}),
      provider: resolved.provider,
      agent: resolved.agent,
      envelope: { ...args.envelope, payloadFingerprint: hostFingerprint }
    },
    ...(atRest
      ? {
          atRest: args.firstMessage
            ? {
                firstMessage: {
                  ...args.firstMessage,
                  ...(omitEffort && args.firstMessage.selection
                    ? {
                        selection: Object.fromEntries(
                          Object.entries(args.firstMessage.selection).filter(
                            ([key]) => key !== 'effort'
                          )
                        )
                      }
                    : {})
                }
              }
            : {}
        }
      : {}),
    tab: { workspaceId: resolved.location.workspaceId, agent: resolved.agent }
  }
}

export async function createStructuredAgentSessionForWorktree(args: {
  runtime: OrcaRuntimeService
  ensureHost: () => Promise<StructuredAgentSessionHost>
  caller: StructuredAgentSessionCaller
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: StructuredAgentId
  activate: boolean
  omitEffort?: true
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
  const prepared = await resolveUncommittedStructuredCreate(
    () => prepareStructuredAgentSessionCreateForWorktree({ ...args, envelope }),
    args.agent
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
