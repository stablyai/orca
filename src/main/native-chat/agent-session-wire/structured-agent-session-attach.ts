// Attach: reserve the session record, then open its journal.
//
// `create` and `ensure` are the same transition with a different starting
// point — a null expected fence means "no session exists yet". Both go through
// the record store's compare-and-swap, which also owns the idempotency row, so
// a retried attach replays instead of reserving a second owner.

import type { AgentType } from '../../../shared/agent-status-types'
import type {
  AgentSessionJournalIdentity,
  AgentSessionProviderHandle
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionAccountHome,
  AgentSessionExecutionLocation,
  AgentSessionLaunchArgs,
  AgentSessionLaunchEnv,
  AgentSessionOwnerRuntimeKind,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  type AgentSessionMutationEnvelope,
  type AgentSessionWireRefusal,
  type AgentSessionWireRefusalCode
} from '../../../shared/agent-session-wire'
import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  openAgentSessionJournalWithRecovery,
  type AgentSessionJournalRecovery
} from './agent-session-journal-recovery'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { structuredAgentSessionRefusalMessage } from './structured-agent-session-refusal-message'

/**
 * Everything a client may declare about the session it wants. Deliberately no
 * spawn token, claim key, or owner probe: those are host observations, and a
 * client that could assert "the previous owner is dead" could steal a live
 * session. The host fills them in.
 */
export type AgentSessionAttachParams = {
  envelope: AgentSessionMutationEnvelope
  location: AgentSessionExecutionLocation
  provider: AgentSessionHandleProvider
  agent: AgentType
  accountHome: AgentSessionAccountHome
  runtimeKind: AgentSessionOwnerRuntimeKind
  /** Omitted only for create-by-intent; the adapter proves the durable handle. */
  providerHandle?: Exclude<AgentSessionProviderHandle, { kind: 'opaque' }>
}

/** Host-supplied half of the reservation. */
export type AgentSessionAttachAuthority = {
  spawnToken: string | (() => string)
  claimKeyId: string
  handoffOperationId: string | null
  probe: AgentSessionOwnerProbe
  launchArgs?: AgentSessionLaunchArgs
  launchEnv?: AgentSessionLaunchEnv
}

/** The fields that define WHICH session this call would attach to. Deliberately
 *  excludes the spawn token and the probe: those differ between a first attempt
 *  and its retry, and a retry must replay rather than conflict. */
export function attachFingerprintFields(params: AgentSessionAttachParams): Record<string, unknown> {
  return {
    location: params.location,
    provider: params.provider,
    agent: params.agent,
    accountHome: params.accountHome,
    runtimeKind: params.runtimeKind,
    providerHandle: params.providerHandle,
    expectedRuntimeFence: params.envelope.expectedRuntimeFence
  }
}

/** Recomputes the fingerprint the client declared and refuses a mismatch before
 *  anything reaches the store. */
export function admitAttachOrRefuse(
  params: AgentSessionAttachParams
): { ok: true; fingerprint: string } | { ok: false; refusal: AgentSessionWireRefusal } {
  if (params.providerHandle && params.providerHandle.kind !== params.provider) {
    return {
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        message: `A ${params.provider} session requires a ${params.provider} provider handle.`
      }
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
  record: AgentSessionRecord,
  params: AgentSessionAttachParams
): AgentSessionJournalIdentity {
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  const providerHandle: AgentSessionProviderHandle =
    head?.handle.provider === 'codex'
      ? { kind: 'codex', threadId: head.handle.threadId }
      : head?.handle.provider === 'claude'
        ? {
            kind: 'claude',
            sessionId: head.handle.sessionId,
            leafUuid: head.handle.leafUuid
          }
        : (params.providerHandle ?? { kind: 'opaque', agent: params.agent, value: 'pending' })
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
  recovery: AgentSessionJournalRecovery | null
  /** Submissions the crash boundary settled as `unknown` on this open. */
  unconfirmedClientMessageIds: string[]
}

/**
 * Open the session's journal, recovering it when the stored one is unusable,
 * and settle every submission left in flight by a previous process. Orca never
 * re-sends those; they surface as delivery unconfirmed.
 */
export async function attachJournal(input: {
  record: AgentSessionRecord
  params: AgentSessionAttachParams
  journalRoot: string
  adapter: StructuredAgentSessionAdapter
}): Promise<AttachedJournal> {
  const identity = journalIdentityFor(input.record, input.params)
  const fence = input.record.lease.runtimeFence
  const historyFilePath = input.adapter.historyFilePath
    ? await input.adapter.historyFilePath({ identity })
    : null
  const opened = await openAgentSessionJournalWithRecovery({
    identity,
    journalDir: journalDirectoryFor(input.journalRoot, {
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId
    }),
    fence,
    historyFilePath
  })
  return {
    ...opened,
    unconfirmedClientMessageIds: await opened.journal.markPendingSubmissionsUnknown(fence)
  }
}

export function reserveRequestFor(input: {
  sessionId: string
  params: AgentSessionAttachParams
  authority: AgentSessionAttachAuthority
  callerKey: string
  fingerprint: string
  now: number
}): Parameters<AgentSessionRecordStore['reserveOwner']>[0] {
  const { params, authority } = input
  return {
    sessionId: input.sessionId,
    location: params.location,
    provider: params.provider,
    accountHome: params.accountHome,
    ...(authority.launchArgs ? { launchArgs: authority.launchArgs } : {}),
    ...(authority.launchEnv ? { launchEnv: authority.launchEnv } : {}),
    runtimeKind: params.runtimeKind,
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

/** The store signals refusals by throwing the refusal code. Anything not in the
 *  known set is a defect, not a client error, and is rethrown. */
export function classifyStoreFailure(
  error: unknown,
  currentFence: number | null,
  record: AgentSessionRecord | null = null
): AgentSessionWireRefusal {
  const rawCode = error instanceof Error ? error.message : String(error)
  if (!(AGENT_SESSION_WIRE_REFUSAL_CODES as readonly string[]).includes(rawCode)) {
    throw error
  }
  const code = rawCode as AgentSessionWireRefusalCode
  return {
    code,
    // Why: a latched session is exactly where a bare store code strands the user.
    message:
      structuredAgentSessionRefusalMessage(code, record) ??
      `The session store refused this call: ${code}.`,
    ...(code === 'agent_session_checkpoint_stale' && currentFence !== null ? { currentFence } : {})
  }
}
