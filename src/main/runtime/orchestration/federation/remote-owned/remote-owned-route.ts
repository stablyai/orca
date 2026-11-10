import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcContext, RpcMethod, RpcRequest } from '../../../rpc/core'
import {
  checkDeclaredOrchestrationAccess,
  type OrchestrationMethodAccessDeclaration
} from '../../../rpc/methods/orchestration/access/orchestration-method-access'
import { emptyWorkerListPage } from '../../../rpc/methods/orchestration/worker/worker-list-method'
import { ORCHESTRATION_FLEET_PAGE_MAX } from '../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import { WorkerStartParams } from '../../../../../shared/rpc-contract/orchestration-worker-start-params'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import {
  getRemoteDispatch,
  oweRemoteDispatchStop,
  remoteStopKey
} from '../../db/remote-owned/remote-dispatch-records'
import { OrchestrationError } from '../../orchestration-error'
import { adoptRemoteAttempt } from '../../db/remote-owned/remote-placements'
import {
  getOpenRemoteRunLink,
  getRemoteRunLink,
  type RemoteRunLinkRow
} from '../../db/remote-owned/remote-run-links'
import { callRemoteOwnedServer } from './remote-owned-calls'
import { remoteForwardKey, type RemoteForwardKey } from './remote-forward-caller'
import { inServerTerms, serverNeverAnswered } from './remote-owned-answers'
import { sendOwedRemoteStop } from './remote-owed-actions'
import { offlineRemoteWorkerShow, remoteServerName } from './remote-owned-reads'
import { explainRemoteServerFailure, isRemoteServerUnreachable } from './remote-server-unreachable'
import { serverOwnsPlacedWorkers, startRemoteOwnedWorker } from './remote-owned-start'

type Routed = { handled: false } | { handled: true; result: unknown }

const LOCAL: Routed = { handled: false }
// Long enough for a send that starts a follow-up worker there and waits for it to be ready.
const FORWARD_TIMEOUT_MS = 180_000
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
  const on = access.server && stringField(values, access.server)
  if (on !== undefined) {
    return routeServerCall(runtime, request, access, values, ctx, on)
  }
  const subject = remoteSubject(db, access, values)
  if (!subject) {
    return LOCAL
  }
  checkDeclaredOrchestrationAccess(access, params, ctx)
  const forward = remoteForwardKey(
    runtime,
    ctx,
    access.caller && stringField(values, access.caller),
    request.orchestrationRequestId
  )
  if (request.method === 'orchestration.workerStop' && subject.dispatchId) {
    return { handled: true, result: await stopRemoteWorker(runtime, subject, forward) }
  }
  return {
    handled: true,
    result: await forwardToLink(runtime, subject, request.method, access, values, forward)
  }
}

/** `--on <server>`: a start, a list, or a receipt lookup there. */
async function routeServerCall(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  access: OrchestrationMethodAccessDeclaration,
  values: Values,
  ctx: RpcContext,
  on: string
): Promise<Routed> {
  if (!SERVER_CALLS.has(request.method)) {
    return LOCAL
  }
  checkDeclaredOrchestrationAccess(access, values, ctx)
  const server = runtime.resolveOrchestrationWorkerServer(on)
  const db = runtime.getOrchestrationDb()
  if (request.method === 'orchestration.workerStart') {
    if (!(await serverOwnsPlacedWorkers(runtime, server))) {
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
    const link = runId ? openLinkFor(db, runId, server.environmentId) : undefined
    if (runId && !link) {
      return {
        handled: true,
        result: emptyWorkerListPage(numberField(values, 'limit') ?? ORCHESTRATION_FLEET_PAGE_MAX)
      }
    }
    const forwarded = paramsForServer(access, values)
    return {
      handled: true,
      result: link
        ? await forwardToLink(runtime, { link }, request.method, access, values)
        : await runtime.callOrchestrationWorkerServer(
            server.environmentId,
            request.method,
            forwarded,
            FORWARD_TIMEOUT_MS,
            undefined,
            { expectedEnvironmentPairingRevision: server.pairingRevision }
          )
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
      FORWARD_TIMEOUT_MS,
      undefined,
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )
    return { handled: true, result: inServerTerms(answer, forward, server.name) }
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
    const question =
      kind === 'message' && value
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of one column returns exactly that column.
          (db.db
            .prepare('SELECT conversation_id FROM remote_owned_questions WHERE message_id = ?')
            .get(value) as { conversation_id: string } | undefined)
        : undefined
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
      timeoutMs: FORWARD_TIMEOUT_MS,
      ...(forward ? { requestId: forward.key } : {}),
      whileLink: ['open']
    })
    seedNamedDispatches(db, link, answer)
    return inServerTerms(answer, forward, server)
  } catch (error) {
    const record = dispatchId ? getRemoteDispatch(db, dispatchId) : undefined
    if (record && method === 'orchestration.workerShow' && isRemoteServerUnreachable(error)) {
      // The server is off: what this Orca last heard about the worker, never its output.
      return offlineRemoteWorkerShow(runtime, record)
    }
    throw inServerTerms(
      explainRemoteServerFailure(error, { server, method, params, dispatchId }),
      forward,
      server
    )
  }
}

/** A stop is owed until the server proves it; the ordinary stop answers when it can, and the pull loop resends otherwise. */
async function stopRemoteWorker(
  runtime: OrcaRuntimeService,
  subject: RemoteSubject,
  forward: RemoteForwardKey | undefined
): Promise<unknown> {
  const db = runtime.getOrchestrationDb()
  const dispatchId = subject.dispatchId!
  const server = remoteServerName(runtime, subject.link.environment_id)
  const owed = oweRemoteDispatchStop(db, dispatchId, forward?.key ?? `stop:${randomUUID()}`)
  if (!owed) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Worker Dispatch ${dispatchId} was not found.`
    )
  }
  runtime.ensureOrchestrationFederationRelay(subject.link.run_id)
  // The server knows this attempt by its stop key; the caller knows only its own request ID.
  const stopKey = forward && { key: remoteStopKey(owed.record), requestId: forward.requestId }
  try {
    return inServerTerms(await sendOwedRemoteStop(runtime, owed.record), stopKey, server)
  } catch (error) {
    if (!serverNeverAnswered(error) || !getOpenRemoteRunLink(db, subject.link.conversation_id)) {
      throw inServerTerms(error, stopKey, server)
    }
    return {
      dispatchId,
      state: 'stop_requested',
      server,
      next: `${server} did not answer, so the stop is owed: this Orca sends it again until ${server} confirms the worker stopped.`
    }
  }
}

/** A Dispatch the server's answer names (a follow-up it started) is its; record it so commands about it route there. */
function seedNamedDispatches(db: OrchestrationDb, link: RemoteRunLinkRow, answer: unknown): void {
  const named = answer && typeof answer === 'object' ? (answer as Values) : {}
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

function openLinkFor(
  db: OrchestrationDb,
  runId: string,
  environmentId: string
): RemoteRunLinkRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return db.db
    .prepare(
      `SELECT * FROM remote_run_links WHERE run_id = ? AND environment_id = ? AND state = 'open'`
    )
    .get(runId, environmentId) as RemoteRunLinkRow | undefined
}

function stringField(values: Values, field: string): string | undefined {
  const value = values[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberField(values: Values, field: string): number | undefined {
  const value = values[field]
  return typeof value === 'number' ? value : undefined
}
