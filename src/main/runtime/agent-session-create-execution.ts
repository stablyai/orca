import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  parseAgentSessionOperationTimestamp,
  type RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  AgentSessionCreateReceiptSchema,
  readAgentSessionCreatedTerminal,
  type AgentSessionCreateReceipt
} from './agent-session-create-receipt'
import { isAgentSessionOperationOutcomeUnknown } from './runtime-agent-launch-resolution'

type CreateExecution = {
  store: AgentSessionRecordStore
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
  prepare: () => Promise<AgentSessionCreateReceipt>
  spawn: (
    receipt: AgentSessionCreateReceipt,
    dispatched: () => void
  ) => Promise<RuntimeTerminalCreate>
  reconcile: (receipt: AgentSessionCreateReceipt) => Promise<RuntimeTerminalCreate | null>
}

function readReceipt(row: AgentSessionOperationRow): AgentSessionCreateReceipt {
  const parsed = AgentSessionCreateReceiptSchema.safeParse(row.terminalCreate)
  if (!parsed.success) {
    throw new Error('agent_session_operation_unknown')
  }
  return parsed.data
}

async function replayCreate(
  args: CreateExecution,
  row: AgentSessionOperationRow
): Promise<RuntimeCreateAgentSessionResult> {
  const receipt = readReceipt(row)
  const { outcome } = row
  const recorded =
    outcome.status === 'succeeded' ? readAgentSessionCreatedTerminal(outcome.terminalCreate) : null
  let adopted: RuntimeTerminalCreate | null = null
  try {
    adopted = await args.reconcile(receipt)
  } catch {
    // Contact loss never grants another spawn.
  }
  if (adopted) {
    const terminal = {
      ...recorded,
      ...adopted,
      tabId: receipt.tabId,
      paneKey: `${receipt.tabId}:${receipt.leafId}`
    }
    await recordOutcome(args, { status: 'succeeded', sessionId: '', terminalCreate: terminal })
    return { terminal, disposition: 'replayed' }
  }
  if (recorded) {
    return { terminal: recorded, disposition: 'replayed' }
  }
  throw new Error(
    outcome.status === 'failed'
      ? (outcome.message ?? outcome.code)
      : outcome.status === 'unknown'
        ? (outcome.message ?? 'agent_session_operation_unknown')
        : 'agent_session_operation_unknown'
  )
}

async function recordOutcome(
  args: CreateExecution,
  outcome: Parameters<AgentSessionRecordStore['recordOperationOutcome']>[0]['outcome']
): Promise<void> {
  try {
    await args.store.recordOperationOutcome({
      callerKey: args.callerKey,
      operationId: args.operationId,
      outcome
    })
  } catch (error) {
    // The durable claim still fences replay when settlement fails.
    console.warn('[agent-session-create] could not record outcome', error)
  }
}

export async function executeAgentSessionCreate(
  args: CreateExecution
): Promise<RuntimeCreateAgentSessionResult> {
  const found = args.store.getOperationRow(args.callerKey, args.operationId)
  const existing = found && found.expiresAt > args.now ? found : null
  if (existing) {
    if (existing.fingerprint !== args.fingerprint) {
      throw new Error('agent_session_operation_conflict')
    }
    if (existing.outcome.status !== 'pending') {
      return replayCreate(args, existing)
    }
  }
  if (!existing) {
    const timestamp = parseAgentSessionOperationTimestamp(args.operationId)
    if (timestamp === null) {
      throw new Error('agent_session_operation_invalid')
    }
    if (args.now - timestamp > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) {
      throw new Error('agent_session_operation_expired')
    }
  }
  const receipt = existing ? readReceipt(existing) : await args.prepare()
  const { decision, claim } = await args.store.admitAndClaimOperation(
    {
      callerKey: args.callerKey,
      operationId: args.operationId,
      fingerprint: args.fingerprint,
      now: args.now,
      terminalCreate: receipt
    },
    (admitted) =>
      admitted.decision === 'admit' ||
      (admitted.decision === 'replay' && admitted.row.outcome.status === 'pending')
  )
  if (decision.decision === 'refused') {
    throw new Error(decision.code)
  }
  if (!claim || claim.claim === 'absent') {
    if (decision.decision === 'replay') {
      return replayCreate(args, decision.row)
    }
    throw new Error('agent_session_operation_unknown')
  }
  if (claim.claim === 'lost') {
    return replayCreate(args, claim.row)
  }
  let dispatched = false
  try {
    const terminal = await args.spawn(receipt, () => {
      dispatched = true
    })
    await recordOutcome(args, { status: 'succeeded', sessionId: '', terminalCreate: terminal })
    return { terminal, disposition: 'created' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await recordOutcome(
      args,
      dispatched || isAgentSessionOperationOutcomeUnknown(error)
        ? { status: 'unknown', message }
        : { status: 'pending' }
    )
    throw error
  }
}
