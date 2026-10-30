/** Resolve session identity before params, compatibility, receipts and dispatch branching; ids identify same-user callers, not credentials.
 * Refuse paired/SSH/WSL claims, provider ids that rotate on /clear, and non-live leases; a released (sleeping) one may act except as NEEDS_RUNNING_AGENT lists. Session identity overrides declarations and maps workers to minted handles/panes.
 * Without session evidence, a declared orca_session_id: may resolve a worker handle; a chat address alone identifies no caller. */
import {
  agentSessionLeaseAdmitsWriter,
  agentSessionLeaseIsReleased
} from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../../shared/agent-session-caller-env'
import {
  ORCA_SESSION_ADDRESS_PREFIX,
  isOrcaSessionId,
  parseOrcaSessionAddress
} from '../../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationSessionCaller } from '../orchestration/orchestration-caller-identity'
import { OrchestrationError } from '../orchestration/orchestration-error'
import { canonicalOrcaSessionId } from '../orchestration/canonical-orca-session-id'
import type { OrchestrationDb } from '../orchestration/db'
import {
  resolveDeclaredCallerParty,
  resolveOrcaSessionParty,
  resolveOrchestrationParty
} from '../orchestration/orchestration-party'
import { lookupOrcaAgentSession } from '../orchestration/structured-session-mail-address'
import { conversationRecordReader } from '../orchestration/structured-session-lineage'
import type { AgentSessionRecordStore } from '../agent-session-record-store'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredWorkerHostScope } from '../structured-worker-identity'
import type { RpcRequest } from './core'

type CallerParam = 'from' | 'terminal' | 'callerTerminalHandle'

/** Add each caller-reading method here with a test; unlisted methods still validate session claims but carry no caller identity. */
export const ORCHESTRATION_CALLER_PARAM: Readonly<Record<string, CallerParam>> = {
  'orchestration.runCreate': 'from',
  'orchestration.runUse': 'from',
  'orchestration.runCurrent': 'from',
  'orchestration.check': 'terminal',
  'orchestration.send': 'from',
  'orchestration.reply': 'from',
  'orchestration.ask': 'from',
  'orchestration.dispatch': 'from',
  'orchestration.gateCreate': 'from',
  'orchestration.gateResolve': 'from',
  'orchestration.gateList': 'from',
  'orchestration.taskCreate': 'callerTerminalHandle',
  'orchestration.taskList': 'callerTerminalHandle',
  'orchestration.taskUpdate': 'callerTerminalHandle',
  'orchestration.workerStart': 'from'
}

export type OrchestrationRequestRoute = {
  /** Set only by the paired WebSocket route: the request came from another host's client. */
  pairedDeviceId?: string
}

export type ResolvedOrchestrationRequest = {
  /** The request with its declared caller bound to the session and its evidence reduced to it. */
  request: RpcRequest
  caller?: OrchestrationSessionCaller
}

const NO_EFFECTS = { effectsApplied: false } as const

/** A released (sleeping) session is still itself, so its background commands may act, except here. */
const NEEDS_RUNNING_AGENT: ReadonlySet<string> = new Set([
  // Each reads, or waits on and so holds back, the mail that wakes the session.
  'orchestration.check',
  'orchestration.ask',
  // Answers that the session is live.
  'orchestration.callerShow'
])

/** Detect session evidence or a declared session caller synchronously so terminal calls avoid another async hop. */
export function needsOrchestrationCallerResolution(request: RpcRequest): boolean {
  if (!request.method.startsWith('orchestration.')) {
    return false
  }
  return (
    request.orchestrationCompatibilityEvidence?.agentSessionId !== undefined ||
    declaredSessionAddress(request) !== undefined
  )
}

function declaredSessionAddress(request: RpcRequest): string | undefined {
  const name = ORCHESTRATION_CALLER_PARAM[request.method]
  const params: unknown = request.params
  if (!name || !params || typeof params !== 'object' || Array.isArray(params)) {
    return undefined
  }
  const values: Record<string, unknown> = { ...params }
  const declared = values[name]
  return typeof declared === 'string' && parseOrcaSessionAddress(declared) ? declared : undefined
}

/** Only for a request `needsOrchestrationCallerResolution` accepts. Throws the refusal, if any. */
export async function resolveOrchestrationSessionCaller(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  route: OrchestrationRequestRoute | undefined
): Promise<ResolvedOrchestrationRequest> {
  const evidence = request.orchestrationCompatibilityEvidence
  if (evidence?.agentSessionId === undefined) {
    return { request: bindDeclaredSessionAddress(runtime.getOrchestrationDb(), request) }
  }
  const claimed: unknown = evidence?.agentSessionId
  if (route?.pairedDeviceId !== undefined) {
    throw hostBoundary(
      'This request reached Orca from a paired client, and an Orca session ID identifies a caller only on the host that runs that session.'
    )
  }
  if (evidence?.host) {
    throw hostBoundary(
      `This command ran in ${evidence.host.kind === 'ssh' ? 'an SSH' : 'a WSL'} environment, and an Orca session ID identifies a caller only on the host that runs that session.`
    )
  }
  if (typeof claimed !== 'string' || !isOrcaSessionId(claimed)) {
    throw new OrchestrationError(
      CODES.unknown,
      'The caller named an ID that is not an Orca session ID. No effects were applied.',
      NO_EFFECTS
    )
  }
  const sessionId = claimed
  const record = await readSessionRecord(runtime, sessionId)
  assertSessionCanAct(sessionId, record, request.method)
  const db = runtime.getOrchestrationDb()
  const caller: OrchestrationSessionCaller = Object.freeze({
    ...resolveOrcaSessionParty(sessionId, db),
    sessionId,
    workspaceId: record.location.workspaceId
  })
  return {
    request: {
      ...request,
      params: bindDeclaredCaller(request.method, request.params, caller, db),
      // Session identity wins; discard terminal attestation on the same request.
      orchestrationCompatibilityEvidence: { agentSessionId: sessionId }
    },
    caller
  }
}

async function readSessionRecord(
  runtime: OrcaRuntimeService,
  sessionId: string
): Promise<AgentSessionRecord> {
  let store: AgentSessionRecordStore | null
  try {
    await runtime.ensureStructuredAgentSessionHost()
    store = getStructuredAgentSessionHost()?.deps.store ?? null
  } catch {
    store = null
  }
  if (!store) {
    throw new OrchestrationError(
      CODES.notLive,
      `Agent session ${sessionId} cannot be verified: this Orca is not running its agent-session host. No effects were applied.`,
      NO_EFFECTS
    )
  }
  const found = lookupOrcaAgentSession(conversationRecordReader(store), sessionId)
  if (found.kind === 'found') {
    return store.requireWritableRecord(found.record.sessionId)
  }
  if (found.kind === 'provider-id') {
    throw new OrchestrationError(
      CODES.providerId,
      `${sessionId} is the provider's own session id, which changes on /clear. This session's Orca session ID is ${ORCA_SESSION_ADDRESS_PREFIX}${found.orcaSessionId}; set ${ORCA_AGENT_SESSION_ID_ENV}=${found.orcaSessionId} instead. No effects were applied.`,
      { ...NO_EFFECTS, orcaSessionId: found.orcaSessionId }
    )
  }
  throw new OrchestrationError(
    CODES.unknown,
    `No Orca agent session ${sessionId} exists on this host. No effects were applied.`,
    NO_EFFECTS
  )
}

function assertSessionCanAct(sessionId: string, record: AgentSessionRecord, method: string): void {
  if (!structuredWorkerHostScope(record.location)) {
    throw hostBoundary(
      `Agent session ${sessionId} runs on another host, and an Orca session ID identifies a caller only on the host that runs that session.`
    )
  }
  const { lease } = record
  if (
    agentSessionLeaseAdmitsWriter(lease) ||
    (agentSessionLeaseIsReleased(lease) && !NEEDS_RUNNING_AGENT.has(method))
  ) {
    return
  }
  const reason = agentSessionLeaseIsReleased(lease)
    ? 'is not running right now. Its commands can still send; it reads its mail once new mail or a user turn wakes it.'
    : lease.handoffStage !== null
      ? 'is changing owners on this host. Retry when that finishes.'
      : 'has no live owner on this host right now. Retry once it is running.'
  throw new OrchestrationError(
    CODES.notLive,
    `Agent session ${sessionId} ${reason} No effects were applied.`,
    NO_EFFECTS
  )
}

/** A request with no session id that declares an `orca_session_id:` caller: a worker's is its handle. */
function bindDeclaredSessionAddress(db: OrchestrationDb, request: RpcRequest): RpcRequest {
  const name = ORCHESTRATION_CALLER_PARAM[request.method]
  const declared = declaredSessionAddress(request)
  const params: unknown = request.params
  if (!name || declared === undefined || !params || typeof params !== 'object') {
    return request
  }
  const party = resolveDeclaredCallerParty(declared, db)
  return { ...request, params: { ...params, [name]: party.address } }
}

/** Whether a declared caller names this session: any spelling that resolves to its party. */
function declaredNamesCaller(
  declared: unknown,
  caller: OrchestrationSessionCaller,
  db: OrchestrationDb
): boolean {
  if (typeof declared !== 'string') {
    return false
  }
  if (isOrcaSessionId(declared)) {
    return canonicalOrcaSessionId(declared) === caller.orcaSessionId
  }
  try {
    return resolveOrchestrationParty(declared, db).address === caller.address
  } catch {
    return false
  }
}

/** The declared caller, if any, must name this session; it is then replaced by its address. */
function bindDeclaredCaller(
  method: string,
  params: unknown,
  caller: OrchestrationSessionCaller,
  db: OrchestrationDb
): unknown {
  const name = ORCHESTRATION_CALLER_PARAM[method]
  if (!name || !params || typeof params !== 'object' || Array.isArray(params)) {
    return params
  }
  const values: Record<string, unknown> = { ...params }
  const declared = values[name]
  if (declared !== undefined && !declaredNamesCaller(declared, caller, db)) {
    throw consumerFenced(caller, String(declared))
  }
  // Check restart fallback may use only the session's own pane key.
  if (values.terminalPaneKey !== undefined && values.terminalPaneKey !== caller.paneKey) {
    throw consumerFenced(caller, `pane ${String(values.terminalPaneKey)}`)
  }
  values[name] = caller.address
  return values
}

function consumerFenced(caller: OrchestrationSessionCaller, declared: string): OrchestrationError {
  return new OrchestrationError(
    'consumer_fenced',
    `This caller is agent session ${caller.sessionId} and cannot act as ${declared}. No effects were applied.`,
    NO_EFFECTS
  )
}

function hostBoundary(reason: string): OrchestrationError {
  return new OrchestrationError(
    CODES.hostBoundary,
    `${reason} Run the command on that host. No effects were applied.`,
    NO_EFFECTS
  )
}
