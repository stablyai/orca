import type { HostFoundingAttempt } from '../../../agent-launch/host-founding-attempt'
// Resolve the host launch identity, then commit an at-rest create or the compatible acquired path.

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
import { savedAgentSessionCatalogModels } from '../../../native-chat/agent-session-wire/structured-agent-session-pick-reply'
import type { StructuredAgentSessionCreateOptions } from '../../../native-chat/agent-session-wire/structured-agent-session-create'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  captureStructuredAgentCliSource,
  type StructuredAgentCliSourceEvidence
} from '../../../native-chat/structured-agent-cli-source'
import type { StructuredAgentId } from '../../../../shared/agent-session-provider-handle'
import {
  resolveUncommittedStructuredCreate,
  type StructuredCreateRefused
} from './structured-agent-session-precommit-refusal'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { structuredAgentSessionClosedBeforeCreate } from './structured-agent-session-close-before-create'
import { structuredLaunchSeedOnSavedListing } from '../../session-tabs/structured-launch-seed-listing'
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
  structuredAgentCliSourceEvidence?: StructuredAgentCliSourceEvidence
  /** Explicit picks override seed keys at rest; acquired in-process launches replace the seed. */
  options?: Readonly<Record<string, string>>
  /** The tab id the caller reserved for this chat, taken when its tab is published; absent, the tab
   *  gets the id clients derive. Beside `options`, after the fingerprint, likewise. */
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  atRest?: boolean
}): Promise<PreparedStructuredAgentSessionCreate> {
  const structuredAgentCliSourceEvidence =
    args.structuredAgentCliSourceEvidence ??
    (args.resumeFrom?.cliSource
      ? captureStructuredAgentCliSource(() => args.runtime.getAgentProviderSessionRows())
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
  const priorOperation = host.deps.store.getOperationRow(
    args.caller.callerKey,
    args.envelope.clientOperationId
  )
  // Recorded operations retain their contract across capability and setup changes.
  const legacyReplay =
    args.firstMessage === undefined &&
    args.options === undefined &&
    priorOperation?.fingerprint === attachFingerprint
  const atRest =
    priorOperation?.fingerprint === args.envelope.payloadFingerprint ||
    ((args.atRest === true || host.deps.setupHold?.(resolved.location.workspaceId) != null) &&
      !legacyReplay)
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
  // The ledger covers explicit overrides, never defaults that settings can change on replay.
  // Explicit picks replace the saved selection; the permission default is the chat's own.
  const picked = args.options
    ? atRest
      ? { ...resolved.options, ...args.options }
      : { ...seededPermissionMode(resolved.options), ...args.options }
    : resolved.options
  // The folder the new-chat picker read its list for, resolved once: the seed and the host's
  // admission read the same list.
  let folder: Promise<string | null> | undefined
  const catalogFolder = () =>
    (folder ??= args.runtime
      .resolveStructuredAgentSessionLocalWorkspacePath(args.worktree)
      .catch(() => null))
  // After the fingerprints: a remembered model the saved listing no longer names moves, with the
  // effort the create runs under it. A model the create names itself is never moved.
  const options = args.options?.model
    ? picked
    : await structuredLaunchSeedOnSavedListing(host, args.agent, picked, catalogFolder)
  const catalogModels =
    options && host.deps.modelCatalog
      ? await savedAgentSessionCatalogModels(
          host.deps,
          resolved.provider,
          args.envelope.sessionId,
          await catalogFolder()
        )
      : undefined
  return {
    host,
    ...(catalogModels ? { catalogModels } : {}),
    ...(hostLaunchDirectory ? { hostLaunchDirectory } : {}),
    attachParams: {
      ...resolvedAttach,
      ...(options ? { options } : {}),
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
  hostFoundingAttempt?: HostFoundingAttempt
  tabPlacement?: ChatTabPlacement
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { prepared } = args
  const tab = prepared.tab
  const tabPlace = {
    ...(args.placedByWindow ? { placedByWindow: true } : {}),
    ...(args.tabPlacement ? { placement: args.tabPlacement } : {})
  }
  let adoptedTabPublicationFailed = false
  const publishTab = tab
    ? async () => {
        if (
          ORCA_LAYOUT_OWNER_IS_MAIN &&
          structuredAgentSessionClosedBeforeCreate(prepared.attachParams.envelope.sessionId)
        ) {
          return
        }
        try {
          const adopted = args.hostFoundingAttempt?.adopted
          await args.runtime.publishStructuredAgentSessionTab({
            workspaceId: adopted?.workspaceId ?? tab.workspaceId,
            sessionId: adopted?.sessionId ?? prepared.attachParams.envelope.sessionId,
            agent: adopted?.agent ?? tab.agent,
            activate: args.activate,
            ...(args.hostFoundingAttempt ? { foundingAttempt: args.hostFoundingAttempt } : {}),
            ...tabPlace,
            ...((adopted?.tabId ?? prepared.attachParams.surfaceTabId)
              ? { tabId: adopted?.tabId ?? prepared.attachParams.surfaceTabId }
              : {})
          })
        } catch (error) {
          prepared.host.deps.logger.warn('publishing the tab of a created chat failed', {
            scope: 'create-tab-publication',
            sessionId: prepared.attachParams.envelope.sessionId,
            error
          })
          if (!prepared.atRest && prepared.attachParams.adopt) {
            // Imported history keeps the acquired route's receipt even if early notification fails.
            adoptedTabPublicationFailed = true
            return
          }
          throw new AgentSessionRefusalError(
            refuse(
              'agent_session_operation_unknown',
              { reason: 'tabUnconfirmed' },
              'The chat may have been created, but its tab could not be confirmed.'
            )
          )
        }
      }
    : undefined
  if (prepared.atRest) {
    return prepared.host.create(args.caller, prepared.attachParams, {
      ...prepared.atRest,
      ...(args.hostFoundingAttempt ? { hostFoundingAttempt: args.hostFoundingAttempt } : {}),
      ...(prepared.catalogModels ? { catalogModels: prepared.catalogModels } : {}),
      ...(prepared.hostLaunchDirectory
        ? { hostLaunchDirectory: prepared.hostLaunchDirectory }
        : {}),
      ...(publishTab ? { publishTab } : {})
    })
  }
  const attached = await prepared.host.attach(args.caller, prepared.attachParams, {
    ...(prepared.hostLaunchDirectory ? { hostLaunchDirectory: prepared.hostLaunchDirectory } : {}),
    ...(prepared.catalogModels ? { catalogModels: prepared.catalogModels } : {}),
    ...(publishTab ? { publishTab } : {})
  })
  return adoptedTabPublicationFailed && attached.ok
    ? {
        ok: false,
        refusal: refuse(
          'agent_session_operation_unknown',
          { reason: 'tabUnconfirmed' },
          'The chat may have been created, but its tab could not be confirmed.'
        )
      }
    : attached
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
  /** Create without starting the agent; its first message starts it. */
  atRest?: true
  firstMessage?: StructuredAgentSessionFirstMessage
  hostFoundingAttempt?: HostFoundingAttempt
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  // An at-rest create's ledger row is keyed by its intent, as a client's create is.
  const envelope = args.atRest
    ? {
        ...args.envelope,
        payloadFingerprint: structuredAgentSessionCreateIntentFingerprint(args)
      }
    : args.envelope
  const prepared: PreparedStructuredAgentSessionCreate | StructuredCreateRefused =
    await resolveUncommittedStructuredCreate(() =>
      prepareStructuredAgentSessionCreateForWorktree({ ...args, envelope })
    )
  if ('refusal' in prepared) {
    return { ok: false, refusal: prepared.refusal }
  }
  return commitStructuredAgentSessionCreate({
    runtime: args.runtime,
    caller: args.caller,
    prepared,
    ...(args.hostFoundingAttempt ? { hostFoundingAttempt: args.hostFoundingAttempt } : {}),
    activate: args.activate
  })
}

function seededPermissionMode(
  options: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const mode = options?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  return mode ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: mode } : {}
}
