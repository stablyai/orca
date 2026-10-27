import { activeProviderContext } from '../../../shared/agent-session-provider-context'
// Store CAS and idempotency rows make retried create/ensure replay instead of reserving another owner.

import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type {
  StructuredAgentId,
  AgentSessionProviderHandle,
  AgentSessionProviderHandleLink
} from '../../../shared/agent-session-provider-handle'
import {
  agentSessionProviderHandleBelongsTo,
  agentSessionProviderHandleFromWire,
  type AgentSessionWireProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import type {
  AgentSessionAccountHome,
  AgentSessionExecutionLocation,
  AgentSessionLaunchArgs,
  AgentSessionLaunchEnv,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import {
  AgentSessionRefusalError,
  agentSessionRefusalFromReference,
  agentSessionRefusalReference,
  isAgentSessionWireRefusalCode,
  refuse,
  type AgentSessionMutationEnvelope,
  type AgentSessionRefusalReference,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionRefusalMessage } from './structured-agent-session-refusal-message'

/** Clients cannot assert spawn tokens, claim keys or owner death; only host observations grant authority. */
export type AgentSessionAttachParams = {
  envelope: AgentSessionMutationEnvelope
  location: AgentSessionExecutionLocation
  provider: StructuredAgentId
  agent: StructuredAgentId
  accountHome: AgentSessionAccountHome
  /** Retain native in params because fingerprints include it. */
  runtimeKind: 'native'
  /** Host-only create defaults; remote schemas reject these. */
  options?: Readonly<Record<string, string>>
  /** Exclude tab placement from conversation identity/fingerprints. */
  surfaceTabId?: string
  launchArgs?: string[]
  /** Omit only for create intent; fingerprint the client wire form before adapter proof. */
  providerHandle?: AgentSessionWireProviderHandle
  /** Host-only adoption seeds resume/import. Ordinary ensure handles must not imply adoption. */
  adopt?: {
    providerHandle: AgentSessionProviderHandle
    /** Omit only for exact replay of an already-imported journal. */
    transcriptPath?: string
    source?: { providerSessionId: string; workspaceCwd: string }
  }
}

export type AgentSessionAttachAuthority = {
  launchDirectory?: string
  spawnToken: string | (() => string)
  claimKeyId: string
  handoffOperationId: string | null
  probe: AgentSessionOwnerProbe
  launchArgs?: AgentSessionLaunchArgs
  launchEnv?: AgentSessionLaunchEnv
}

/** Exclude transient spawn/probe evidence and re-resolved defaults so unknown-outcome retries still replay. */
export function attachFingerprintFields(params: AgentSessionAttachParams): Record<string, unknown> {
  return {
    location: params.location,
    provider: params.provider,
    agent: params.agent,
    accountHome: params.accountHome,
    runtimeKind: params.runtimeKind,
    providerHandle: params.providerHandle,
    // Adoption changes identity; transcript location is transient and excluded.
    adoptedProviderHandle: params.adopt?.providerHandle,
    expectedRuntimeFence: params.envelope.expectedRuntimeFence
  }
}

export function admitAttachOrRefuse(
  params: AgentSessionAttachParams
): { ok: true; fingerprint: string } | { ok: false; refusal: AgentSessionWireRefusal } {
  // Record validation and adapter routing must agree on the agent.
  if (params.agent !== params.provider) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'requestMalformed' },
        `A ${params.provider} session cannot be started as ${params.agent}.`
      )
    }
  }
  if (
    params.providerHandle &&
    !agentSessionProviderHandleBelongsTo(
      agentSessionProviderHandleFromWire(params.providerHandle),
      params.provider
    )
  ) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'requestMalformed' },
        `A ${params.provider} session requires a ${params.provider} provider handle.`
      )
    }
  }
  const fingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId: params.envelope.sessionId,
    fields: attachFingerprintFields(params)
  })
  const conflict = agentSessionFingerprintConflict(params.envelope, fingerprint)
  return conflict ? { ok: false, refusal: conflict } : { ok: true, fingerprint }
}

export function journalIdentityFor(
  record: Pick<AgentSessionRecord, 'sessionId' | 'providerHandleChain' | 'providerContextBoundary'>,
  params: AgentSessionAttachParams
): AgentSessionJournalIdentity {
  const active = activeProviderContext(record)
  const head = active.head
  const providerHandle =
    head?.handle ??
    (!active.pendingClear && params.providerHandle
      ? agentSessionProviderHandleFromWire(params.providerHandle)
      : null)
  return {
    sessionId: record.sessionId,
    workspaceId: params.location.workspaceId,
    hostId: params.location.executionHostId,
    agent: params.agent,
    providerHandle
  }
}

export type AttachedJournal = {
  journal: AgentSessionJournal
  /** Submissions the crash boundary left `unknown`; kept on the wire for older peers. */
  unconfirmedClientMessageIds: string[]
}

/** Open settles the crash boundary; missing provider history cannot turn unknown delivery into proven refusal. */
export async function attachJournal(input: {
  record: AgentSessionRecord
  /** The host's open conversation, whose journal the attach adopts. */
  openConversation: (record: AgentSessionRecord) => Promise<AgentSessionJournal>
}): Promise<AttachedJournal> {
  const journal = await input.openConversation(input.record)
  return {
    journal,
    unconfirmedClientMessageIds: journal
      .submissions()
      .filter((entry) => entry.dispatchState === 'unknown' && entry.recovered === true)
      .map((entry) => entry.clientMessageId)
  }
}

/** Adopted conversations start with adopted, never created; provider proof appends resumed unless identical handle/fence makes it a retry. */
const ADOPTED_HANDLE_FENCE = 1

function adoptedProviderHandleLink(
  handle: AgentSessionProviderHandle,
  observedAt: number
): AgentSessionProviderHandleLink {
  return {
    // Pi native IDs are paths; link IDs must be bounded slugs.
    linkId: `${handle.agent}-${ADOPTED_HANDLE_FENCE}-${handle.nativeId}`
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 128),
    handle,
    origin: 'adopted',
    mintedAtFence: ADOPTED_HANDLE_FENCE,
    observedAt
  }
}

export function reserveRequestFor(input: {
  sessionId: string
  params: AgentSessionAttachParams
  authority: AgentSessionAttachAuthority
  callerKey: string
  fingerprint: string
  now: number
  models?: Parameters<AgentSessionRecordStore['reserveOwner']>[0]['models']
}): Parameters<AgentSessionRecordStore['reserveOwner']>[0] {
  const { params, authority } = input
  return {
    sessionId: input.sessionId,
    location: params.location,
    provider: params.provider,
    accountHome: params.accountHome,
    ...(params.options ? { options: params.options, models: input.models } : {}),
    ...(params.envelope.expectedRuntimeFence === null && params.surfaceTabId
      ? { surfaceTabId: params.surfaceTabId }
      : {}),
    ...(authority.launchArgs ? { launchArgs: authority.launchArgs } : {}),
    ...(authority.launchEnv ? { launchEnv: authority.launchEnv } : {}),
    ...(authority.launchDirectory ? { launchDirectory: authority.launchDirectory } : {}),
    ...(params.adopt
      ? {
          // New records begin at fence 1, matching the owner probe’s required head fence.
          adoptedHandleLink: adoptedProviderHandleLink(params.adopt.providerHandle, input.now)
        }
      : {}),
    expectedFence: params.envelope.expectedRuntimeFence,
    spawnToken: authority.spawnToken,
    claimKeyId: authority.claimKeyId,
    handoffOperationId: authority.handoffOperationId,
    probe: authority.probe,
    operation: {
      callerKey: input.callerKey,
      operationId: params.envelope.clientOperationId,
      fingerprint: input.fingerprint
    },
    now: input.now
  }
}

/** Only known store codes are client refusals; rethrow unclassified defects. */
export function classifyStoreFailure(
  error: unknown,
  currentFence: number | null,
  record: AgentSessionRecord | null = null
): AgentSessionWireRefusal {
  const rawCode = error instanceof Error ? error.message : String(error)
  if (!isAgentSessionWireRefusalCode(rawCode)) {
    throw error
  }
  const emitted: AgentSessionRefusalReference =
    error instanceof AgentSessionRefusalError
      ? agentSessionRefusalReference(error.refusal)
      : { code: rawCode }
  // Resolve actionable wording for latched sessions instead of exposing bare store codes.
  const told = structuredAgentSessionRefusalMessage(emitted, record)
  const reference = told?.reference ?? emitted
  return agentSessionRefusalFromReference(
    reference.code === 'agent_session_checkpoint_stale' && currentFence !== null
      ? { code: reference.code, details: { ...reference.details, currentFence } }
      : reference,
    told?.message ?? `The session store refused this call: ${rawCode}.`
  )
}
