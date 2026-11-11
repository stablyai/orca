import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcContext, RpcMethod, RpcRequest } from '../../../rpc/core'
import {
  checkDeclaredOrchestrationAccess,
  type OrchestrationMethodAccessDeclaration
} from '../../../rpc/methods/orchestration/access/orchestration-method-access'
import { emptyWorkerListPage } from '../../../rpc/methods/orchestration/worker/worker-list-method'
import { ORCHESTRATION_FLEET_PAGE_MAX } from '../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/orca-session-address-prefix'
import { WorkerStartParams } from '../../../../../shared/rpc-contract/orchestration-worker-start-params'
import { isOrchestrationMutation } from '../../../../../shared/orchestration/orchestration-rpc-contract'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import {
  getRemoteDispatch,
  getRemoteOwnedQuestion
} from '../../db/remote-owned/remote-dispatch-records'
import { adoptRemoteAttempt } from '../../db/remote-owned/remote-placements'
import {
  getOpenRemoteRunLink,
  getRemoteRunLink,
  type RemoteRunLinkRow
} from '../../db/remote-owned/remote-run-links'
import { callRemoteOwnedServer } from './remote-owned-calls'
import { remoteForwardKey, type RemoteForwardKey } from './remote-forward-caller'
import { inServerTerms, serverNeverAnswered } from './remote-owned-answers'
import { remoteWorkerShow, remoteServerName } from './remote-owned-reads'
import { OrchestrationError } from '../../orchestration-error'
import { latestRunLink, repairedListError } from './re-paired-run-list'
import { explainRemoteServerFailure } from './remote-server-unreachable'
import { serverOwnsPlacedWorkers, startRemoteOwnedWorker } from './remote-owned-start'
import { settleUnansweredAbandon, stopRemoteWorker } from './remote-owned-stop'

type Routed = { handled: false } | { handled: true; result: unknown }

const LOCAL: Routed = { handled: false }
// Long enough for a send that starts a follow-up worker there and waits for it to be ready.
const FORWARD_TIMEOUT_MS = 180_000
// A read gives up soon on a sleeping server, whose socket stays open.
const READ_TIMEOUT_MS = 5_000
// What `--on <server>` sends there; send and reply --on stay peer mail.
const SERVER_CALLS: ReadonlySet<string> = new Set([
  'orchestration.workerStart',
  'orchestration.workerList',
  'orchestration.requestShow'
])

type Values = Record<string, unknown>

/**
 * Before this Orca's receipts: a command about a worker a paired server owns runs there, by that
 * server's ordinary handler, as its Run's coordinator. The worker is found from the subjects the
 * method declares; the caller passes the method's one access check here first, as it would for a
 * worker of its own. A paired Orca's calls always run here: pairing is one-way.
 */
export async function routeRemoteOwnedCall(
  runtime: OrcaRuntimeService,
  method: RpcMethod,
  request: RpcRequest,
  params: unknown,
  ctx: RpcContext
): Promise<Routed> {
  const access = method.orchestrationAccess
  if (!access || access.kind === 'localOnly' || ctx.orchestrationCaller?.kind === 'peer') {
    return LOCAL
  }
  const values: Values = params && typeof params === 'object' ? { ...params } : {}
  const db = runtime.getOrchestrationDb()
  // A start goes to a server only by --on; a remote Dispatch it names (--retry-of) stays this Orca's claim to check.
  const subject =
    request.method === 'orchestration.workerStart' ? undefined : remoteSubject(db, access, values)
  if (!subject) {
    const on = access.server && stringField(values, access.server)
    return on === undefined ? LOCAL : routeServerCall(runtime, request, access, values, ctx, on)
  }
  checkDeclaredOrchestrationAccess(access, params, ctx)
  const record = subject.dispatchId ? getRemoteDispatch(db, subject.dispatchId) : undefined
  if (request.method === 'orchestration.workerShow' && record) {
    // A status read is this Orca's record, never a call there: instant whatever the server is doing.
    return { handled: true, result: remoteWorkerShow(runtime, record) }
  }
  const forward = remoteForwardKey(
    runtime,
    ctx,
    access.caller && stringField(values, access.caller),
    request.orchestrationRequestId
  )
  if (request.method === 'orchestration.workerStop' && subject.dispatchId) {
    return {
      handled: true,
      result: await stopRemoteWorker(runtime, subject.link, subject.dispatchId, forward)
    }
  }
  if (request.method === 'orchestration.workerAbandon' && subject.dispatchId) {
    try {
      return {
        handled: true,
        result: await forwardToLink(runtime, subject, request.method, access, values, forward)
      }
    } catch (error) {
      if (!serverNeverAnswered(error) || !getOpenRemoteRunLink(db, subject.link.conversation_id)) {
        throw error
      }
      return {
        handled: true,
        result: settleUnansweredAbandon(runtime, subject.link, subject.dispatchId)
      }
    }
  }
  return {
    handled: true,
    result: await forwardToLink(runtime, subject, request.method, access, values, forward)
  }
}

/** `--on <server>`: a start, a list, or a receipt lookup there; send and reply --on to anything else stay peer mail. */
async function routeServerCall(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  access: OrchestrationMethodAccessDeclaration,
  values: Values,
  ctx: RpcContext,
  on: string
): Promise<Routed> {
  // A chat named by its session ID is refused by the ordinary start before any server is asked.
  if (!SERVER_CALLS.has(request.method) || isSessionAddress(values.terminal)) {
    return LOCAL
  }
  checkDeclaredOrchestrationAccess(access, values, ctx)
  const server = runtime.resolveOrchestrationWorkerServer(on)
  const db = runtime.getOrchestrationDb()
  if (request.method === 'orchestration.workerStart') {
    if (
      holdsLocalReceipt(db, ctx, request.orchestrationRequestId) ||
      !(await serverOwnsPlacedWorkers(runtime, server))
    ) {
      // An older server: today's remote attachment, the one legacy branch for new work.
      return LOCAL
    }
    return {
      handled: true,
      result: await startRemoteOwnedWorker(
        runtime,
        WorkerStartParams.parse(values),
        ctx,
        request.orchestrationRequestId
      )
    }
  }
  if (request.method === 'orchestration.workerList') {
    const runId = stringField(values, 'run')
    // A Run lists what it placed there, as its coordinator; no Run lists the server as a whole.
    const latest = runId ? latestRunLink(db, runId, server.environmentId) : undefined
    if (latest?.state === 'closed') {
      throw repairedListError(server.name)
    }
    const link = latest?.state === 'open' ? latest : undefined
    if (runId && !link) {
      return {
        handled: true,
        result: emptyWorkerListPage(numberField(values, 'limit') ?? ORCHESTRATION_FLEET_PAGE_MAX)
      }
    }
    const forwarded = paramsForServer(access, values)
    try {
      return {
        handled: true,
        result: link
          ? await forwardToLink(runtime, { link }, request.method, access, values)
          : await runtime.callOrchestrationWorkerServer(
              server.environmentId,
              request.method,
              forwarded,
              READ_TIMEOUT_MS,
              undefined,
              { expectedEnvironmentPairingRevision: server.pairingRevision }
            )
      }
    } catch (error) {
      const closed = link && getRemoteRunLink(db, link.conversation_id)?.state === 'closed'
      if (
        closed ||
        (error instanceof OrchestrationError && error.code === 'server_pairing_changed')
      ) {
        throw repairedListError(server.name)
      }
      throw error
    }
  }
  {
    // The server keyed the request by this caller's scoped key, as the forward that sent it did.
    const forward = remoteForwardKey(
      runtime,
      ctx,
      undefined,
      stringField(values, 'request') ?? randomUUID()
    )!
    const answer = await runtime.callOrchestrationWorkerServer(
      server.environmentId,
      request.method,
      { request: forward.key },
      READ_TIMEOUT_MS,
      undefined,
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )
    return { handled: true, result: inServerTerms(answer, { server: server.name, forward }) }
  }
}

type RemoteSubject = { link: RemoteRunLinkRow; dispatchId?: string }

/** The worker or question a call names, when a paired server owns it. Tasks stay in this Orca's graph. */
function remoteSubject(
  db: OrchestrationDb,
  access: OrchestrationMethodAccessDeclaration,
  values: Values
): RemoteSubject | undefined {
  for (const [field, kind] of Object.entries(access.targets)) {
    const value = stringField(values, field)
    const dispatchId =
      kind === 'dispatch'
        ? value
        : kind === 'party' && value?.startsWith('dispatch:')
          ? value.slice('dispatch:'.length)
          : undefined
    const record = dispatchId ? getRemoteDispatch(db, dispatchId) : undefined
    const question = kind === 'message' && value ? getRemoteOwnedQuestion(db, value) : undefined
    const conversationId = record?.conversation_id ?? question?.conversation_id
    const link = conversationId ? getRemoteRunLink(db, conversationId) : undefined
    if (link) {
      return { link, dispatchId: record?.dispatch_id }
    }
  }
  return undefined
}

/** This Orca's caller, Run and server fields mean nothing there: the server names the caller itself. */
function paramsForServer(access: OrchestrationMethodAccessDeclaration, values: Values): Values {
  const local = new Set<string>(
    [
      access.caller,
      access.callerPane,
      access.server,
      ...Object.entries(access.targets)
        .filter(([, kind]) => kind === 'run')
        .map(([field]) => field)
    ].filter((field): field is string => field !== undefined)
  )
  return Object.fromEntries(Object.entries(values).filter(([field]) => !local.has(field)))
}

async function forwardToLink(
  runtime: OrcaRuntimeService,
  { link, dispatchId }: RemoteSubject,
  method: string,
  access: OrchestrationMethodAccessDeclaration,
  values: Values,
  forward?: RemoteForwardKey
): Promise<unknown> {
  const db = runtime.getOrchestrationDb()
  const server = remoteServerName(runtime, link.environment_id)
  const params = paramsForServer(access, values)
  try {
    const answer = await callRemoteOwnedServer(runtime, link, {
      method,
      params,
      timeoutMs: isOrchestrationMutation(method, params) ? FORWARD_TIMEOUT_MS : READ_TIMEOUT_MS,
      ...(forward ? { requestId: forward.key } : {}),
      whileLink: ['open']
    })
    seedNamedDispatches(db, link, answer)
    return inServerTerms(answer, { server, forward, link })
  } catch (error) {
    throw inServerTerms(explainRemoteServerFailure(error, { server, method, params, dispatchId }), {
      server,
      forward,
      link
    })
  }
}

/** A Dispatch the server's answer names (a follow-up it started) is its; record it so commands about it route there. */
function seedNamedDispatches(db: OrchestrationDb, link: RemoteRunLinkRow, answer: unknown): void {
  const named: Values = answer && typeof answer === 'object' ? { ...answer } : {}
  const dispatchId = stringField(named, 'dispatchId')
  const taskId = stringField(named, 'taskId')
  if (!dispatchId || !taskId || getRemoteDispatch(db, dispatchId)) {
    return
  }
  runLifecycleWriteTransaction(db.db, 'seed_remote_dispatch', () => {
    const open = getOpenRemoteRunLink(db, link.conversation_id)
    if (open) {
      adoptRemoteAttempt(db, open, { taskId, dispatchId })
    }
  })
}

/** A retry of a start this Orca already took on today's path stays there, whatever the server runs now. */
function holdsLocalReceipt(
  db: OrchestrationDb,
  ctx: RpcContext,
  requestId: string | undefined
): boolean {
  const caller =
    ctx.authenticatedCallerFingerprint ?? db.getOrCreateLocalMutationCallerFingerprint()
  return requestId !== undefined && db.getMutationReceipt(caller, requestId) !== undefined
}

function isSessionAddress(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ORCA_SESSION_ADDRESS_PREFIX)
}

function stringField(values: Values, field: string): string | undefined {
  const value = values[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberField(values: Values, field: string): number | undefined {
  const value = values[field]
  return typeof value === 'number' ? value : undefined
}
