import { isDeepStrictEqual } from 'node:util'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { admitAttachOrRefuse, attachJournal } from './structured-agent-session-attach'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredTuiOwner } from './structured-agent-session-handoff-types'
import { isStructuredTuiAdoptionReservation } from './structured-agent-session-tui-adoption-reservation'

export type StructuredTuiAdoptionRequest = {
  caller: StructuredAgentSessionCaller
  params: AgentSessionAttachParams
  owner: StructuredTuiOwner
  onOwnerProven?: () => void
}

export function adoptStructuredTuiOwner(
  input: StructuredTuiAdoptionRequest & {
    deps: StructuredAgentSessionHostDeps
    now: () => number
    publish: (sessionId: string, session: StructuredAgentSessionHostSession) => void
    retain: (sessionId: string, owner: StructuredTuiOwner) => void
    snapshot: (sessionId: string, session: StructuredAgentSessionHostSession) => void
  }
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  return adopt(input)
}

async function adopt(
  input: Parameters<typeof adoptStructuredTuiOwner>[0]
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { params, owner } = input
  const sessionId = params.envelope.sessionId
  const admitted = admitAttachOrRefuse(params)
  if (!admitted.ok) {
    return admitted
  }
  let record = input.deps.store.getRecord(sessionId)
  if (!record) {
    // Adoption reserves the lease before it may prove the pane, and nothing deletes a record, so
    // this call always runs against one. Refusing beats reserving here: a second acquisition mode
    // that no caller can enter is coverage that proves nothing.
    throw new Error('agent_session_ownership_unknown')
  }
  let replayed = true
  if (isStructuredTuiAdoptionReservation(record, owner.process.spawnToken)) {
    // This adoption's own pre-proof reservation: turn it into an owner rather than reserve again.
    replayed = false
    record = await proveAdoptedTuiOwner(input, record)
  } else {
    assertMatchingTuiOwner(record, owner)
  }
  input.onOwnerProven?.()
  const attached = await attachJournal({
    record,
    params,
    journalRoot: input.deps.journalRoot,
    adapter: input.deps.adapter
  })
  const session = { journal: attached.journal, params, fence: record.lease.runtimeFence }
  input.publish(sessionId, session)
  input.retain(sessionId, owner)
  input.snapshot(sessionId, session)
  await input.deps.store.recordOperationOutcome({
    callerKey: input.caller.callerKey,
    operationId: params.envelope.clientOperationId,
    outcome: { status: 'succeeded', sessionId }
  })
  return {
    ok: true,
    replayed,
    fence: record.lease.runtimeFence,
    cursor: attached.journal.cursor(),
    value: {
      sessionId,
      fence: record.lease.runtimeFence,
      snapshot: attached.journal.snapshot(),
      unconfirmedClientMessageIds: attached.unconfirmedClientMessageIds
    }
  }
}

/** Steps 4 and 5 of acquisition against a reservation that already exists at this fence. */
async function proveAdoptedTuiOwner(
  input: Parameters<typeof adoptStructuredTuiOwner>[0],
  record: AgentSessionRecord
): Promise<AgentSessionRecord> {
  const { sessionId } = record
  const fence = record.lease.runtimeFence
  if (record.lease.ownerProcess === null) {
    await input.deps.store.commitProcessIdentity({
      sessionId,
      fence,
      process: input.owner.process,
      now: input.now()
    })
  } else if (!isDeepStrictEqual(record.lease.ownerProcess, input.owner.process)) {
    throw new Error('agent_session_conflict')
  }
  return input.deps.store.proveOwner({
    sessionId,
    fence,
    link: input.owner.link,
    now: input.now()
  })
}

function assertMatchingTuiOwner(
  record: NonNullable<ReturnType<StructuredAgentSessionHostDeps['store']['getRecord']>>,
  owner: StructuredTuiOwner
): void {
  const head = record.providerHandleChain.at(-1)?.handle
  const adopted = owner.link.handle
  if (
    record.lease.runtimeKind !== 'tui' ||
    record.lease.claimStatus !== 'live' ||
    !isDeepStrictEqual(record.lease.ownerProcess, owner.process) ||
    head?.provider !== 'codex' ||
    adopted.provider !== 'codex' ||
    head.threadId !== adopted.threadId
  ) {
    throw new Error('agent_session_conflict')
  }
}
