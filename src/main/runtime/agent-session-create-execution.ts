import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_RPC_ERROR_CODES,
  parseAgentSessionOperationTimestamp,
  type RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import { RECOVERABLE_CODES } from '../../shared/remote-runtime-client-error-classification'
import {
  agentSessionOperationKey,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  admitAndClaimAgentSessionOperationInto,
  settleAgentSessionOperationInto
} from './agent-session-operation-admission'
import {
  readAgentSessionCreateTerminalTarget,
  type AgentSessionCreateTerminalTarget
} from './agent-session-create-terminal-target'
import {
  readAgentSessionCreatedTerminal,
  recordAgentSessionCreatedTerminal
} from './agent-session-create-recorded-terminal'
import { isAgentSessionOperationOutcomeUnknown } from './runtime-agent-launch-resolution'

const REPLAYABLE_CODES: ReadonlySet<string> = new Set(AGENT_SESSION_RPC_ERROR_CODES)

/** What one attempt launches; derived fresh by every attempt that may spawn. */
export type PreparedAgentSessionCreate = {
  target: AgentSessionCreateTerminalTarget
  launch: (dispatched: () => void) => Promise<RuntimeTerminalCreate>
}

/** The ledger calls a create makes: the record store's, or the same rules over rows in memory. */
export type AgentSessionCreateLedger = Pick<
  AgentSessionRecordStore,
  'getOperationRow' | 'admitAndClaimOperation' | 'recordOperationOutcome'
>

/** The durable ledger's own functions over rows this process holds, for when the store is unusable. */
export function createInMemoryAgentSessionCreateLedger(): AgentSessionCreateLedger {
  const state = { operations: new Map<string, AgentSessionOperationRow>() }
  return {
    getOperationRow: (callerKey, operationId) =>
      state.operations.get(agentSessionOperationKey(callerKey, operationId)) ?? null,
    admitAndClaimOperation: async (args, claimAfter) =>
      admitAndClaimAgentSessionOperationInto(state, args, claimAfter),
    recordOperationOutcome: async (args) => settleAgentSessionOperationInto(state, args)
  }
}

type CreateExecution = {
  openStore: () => Promise<AgentSessionRecordStore>
  memory: AgentSessionCreateLedger
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
  prepare: () => Promise<PreparedAgentSessionCreate>
  reconcile: (target: AgentSessionCreateTerminalTarget) => Promise<RuntimeTerminalCreate | null>
}

function warnUnrecorded(error: unknown): void {
  console.warn('[agent-session-create] record store unusable; fencing this create in memory', error)
}

function succeeded(terminal: RuntimeTerminalCreate): AgentSessionOperationOutcome {
  const recorded = recordAgentSessionCreatedTerminal(terminal)
  return { status: 'succeeded', sessionId: '', ...(recorded ? { terminalCreate: recorded } : {}) }
}

async function replayCreate(
  args: CreateExecution,
  ledger: AgentSessionCreateLedger,
  row: AgentSessionOperationRow
): Promise<RuntimeCreateAgentSessionResult> {
  const { outcome } = row
  const recorded =
    outcome.status === 'succeeded' ? readAgentSessionCreatedTerminal(outcome.terminalCreate) : null
  if (recorded) {
    return { terminal: recorded, disposition: 'replayed' }
  }
  const target = readAgentSessionCreateTerminalTarget(row.terminalTarget)
  let adopted: RuntimeTerminalCreate | null = null
  try {
    adopted = target ? await args.reconcile(target) : null
  } catch {
    // Contact loss never grants another spawn.
  }
  if (target && adopted) {
    const terminal = {
      ...adopted,
      tabId: target.tabId,
      paneKey: `${target.tabId}:${target.leafId}`
    }
    await recordOutcome(args, ledger, succeeded(terminal))
    return { terminal, disposition: 'replayed' }
  }
  const stored =
    outcome.status === 'failed'
      ? outcome.code
      : outcome.status === 'unknown'
        ? outcome.message
        : undefined
  // Why: a replay can be hours old; raw first-attempt text (e.g. a dropped SSH link) no longer holds.
  throw new Error(
    stored && REPLAYABLE_CODES.has(stored) && !RECOVERABLE_CODES.has(stored)
      ? stored
      : 'agent_session_operation_unknown'
  )
}

/** Best-effort: the claim already fences replay, and an unsettled claim replays through inventory. */
async function recordOutcome(
  args: CreateExecution,
  ledger: AgentSessionCreateLedger,
  outcome: AgentSessionOperationOutcome
): Promise<void> {
  try {
    await ledger.recordOperationOutcome({
      callerKey: args.callerKey,
      operationId: args.operationId,
      outcome
    })
  } catch (error) {
    console.warn('[agent-session-create] could not record outcome', error)
  }
}

function admitAndClaim(
  args: CreateExecution,
  ledger: AgentSessionCreateLedger,
  terminalTarget: AgentSessionCreateTerminalTarget
): ReturnType<AgentSessionCreateLedger['admitAndClaimOperation']> {
  return ledger.admitAndClaimOperation(
    {
      callerKey: args.callerKey,
      operationId: args.operationId,
      fingerprint: args.fingerprint,
      now: args.now,
      terminalTarget
    },
    (decision) =>
      decision.decision === 'admit' ||
      (decision.decision === 'replay' && decision.row.outcome.status === 'pending')
  )
}

function unexpired(
  row: AgentSessionOperationRow | null | undefined,
  now: number
): AgentSessionOperationRow | null {
  return row && row.expiresAt > now ? row : null
}

/**
 * Bookkeeping never gates the user's start: when the store cannot be opened or written, the same
 * ledger rules run over rows this process holds, so only replay across a restart is lost.
 */
export async function executeAgentSessionCreate(
  args: CreateExecution
): Promise<RuntimeCreateAgentSessionResult> {
  let store: AgentSessionRecordStore | null = null
  try {
    store = await args.openStore()
  } catch (error) {
    warnUnrecorded(error)
  }
  // Why: a row in memory exists only because the store refused it, so it is the newer answer.
  const memoryRow = unexpired(
    args.memory.getOperationRow(args.callerKey, args.operationId),
    args.now
  )
  let ledger: AgentSessionCreateLedger = memoryRow || !store ? args.memory : store
  const existing =
    memoryRow ?? unexpired(store?.getOperationRow(args.callerKey, args.operationId), args.now)
  if (existing) {
    if (existing.fingerprint !== args.fingerprint) {
      throw new Error('agent_session_operation_conflict')
    }
    if (existing.outcome.status !== 'pending') {
      return replayCreate(args, ledger, existing)
    }
  } else {
    const timestamp = parseAgentSessionOperationTimestamp(args.operationId)
    if (timestamp === null) {
      throw new Error('agent_session_operation_invalid')
    }
    if (args.now - timestamp > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) {
      throw new Error('agent_session_operation_expired')
    }
  }
  // Why: a pending row proves nothing was dispatched, so its retry re-runs every check a first attempt does.
  const prepared = await args.prepare()
  let admitted: Awaited<ReturnType<AgentSessionCreateLedger['admitAndClaimOperation']>>
  try {
    admitted = await admitAndClaim(args, ledger, prepared.target)
  } catch (error) {
    // Only the store's write can throw; the in-memory ledger never does.
    warnUnrecorded(error)
    ledger = args.memory
    admitted = await admitAndClaim(args, ledger, prepared.target)
  }
  const { decision, claim } = admitted
  if (decision.decision === 'refused') {
    throw new Error(decision.code)
  }
  if (claim?.claim !== 'won') {
    return replayCreate(args, ledger, claim?.claim === 'lost' ? claim.row : decision.row)
  }
  let dispatched = false
  try {
    const terminal = await prepared.launch(() => {
      dispatched = true
    })
    await recordOutcome(args, ledger, succeeded(terminal))
    return { terminal, disposition: 'created' }
  } catch (error) {
    await recordOutcome(
      args,
      ledger,
      dispatched || isAgentSessionOperationOutcomeUnknown(error)
        ? { status: 'unknown', message: error instanceof Error ? error.message : String(error) }
        : { status: 'pending' }
    )
    throw error
  }
}
