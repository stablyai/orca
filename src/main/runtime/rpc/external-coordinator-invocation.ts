/** A paired runtime client outside any Orca terminal coordinates as its authenticated caller fingerprint, never a borrowed pane.
 * The boundary is the pairing: any same-user process holding that saved environment acts as the same coordinator. */
import { createHash } from 'node:crypto'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration/orchestration-compatibility-evidence'
import { ORCHESTRATION_EXTERNAL_COORDINATOR_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { orchestrationSkillRecoveryData } from '../../../shared/orchestration/orchestration-rpc-contract'
import type { RunRow } from '../orchestration/db/orchestration-records'
import { currentRunExternalCoordinator } from '../orchestration/db/runs/run-external-coordinator'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcContext, RpcRequest } from './core'
import { ORCHESTRATION_CALLER_PARAM } from './orchestration-session-caller'

export type ExternalCoordinatorAuthority =
  | {
      kind: 'create'
      clientFingerprint: string
      mutationCallerFingerprint: string
    }
  | {
      /** No Run, or not the named one, is bound to this fingerprint; run scope decides what that refuses. */
      kind: 'unbound'
      clientFingerprint: string
      mutationCallerFingerprint: string
    }
  | {
      kind: 'bound'
      clientFingerprint: string
      run: RunRow
      mutationCallerFingerprint: string
      /** Throws consumer_fenced once a terminal, session or newer generation took the Run. */
      revalidate: () => RunRow
    }

type CandidateParams = Record<string, unknown>

const NO_EFFECTS = { effectsApplied: false } as const

/** run-use stays terminal-only: binding someone else's Run is a takeover, not coordination. */
function isExternalCoordinatorCandidate(method: string, params: CandidateParams): boolean {
  if (method === 'orchestration.runCreate') {
    return params.external === true
  }
  const callerParam = ORCHESTRATION_CALLER_PARAM[method]
  return method !== 'orchestration.runUse' && callerParam !== undefined && !params[callerParam]
}

/** Replay stays inside one client, Run and consumer generation, so a fenced coordinator cannot replay into its successor. */
function mutationFingerprint(clientFingerprint: string, run?: RunRow): string {
  return createHash('sha256')
    .update(
      run
        ? `external-coordinator:${clientFingerprint}:${run.id}:${run.consumer_generation}`
        : `external-coordinator:${clientFingerprint}:create`
    )
    .digest('hex')
}

type ExternalCoordinatorTransport = Pick<
  RpcContext,
  'clientKind' | 'clientCapabilities' | 'pairedDeviceId' | 'authenticatedCallerFingerprint'
>

/** The caller fingerprint of a paired runtime client that declared the capability and carries no Orca-launched agent evidence; undefined for everyone else. */
function eligibleClientFingerprint(
  evidence: OrchestrationCompatibilityEvidence | undefined,
  transport: ExternalCoordinatorTransport
): string | undefined {
  // Terminal, pane, launch, host or session evidence means an Orca-launched agent, which acts only as itself.
  if (
    transport.clientKind !== 'runtime' ||
    !transport.pairedDeviceId ||
    !transport.authenticatedCallerFingerprint ||
    !transport.clientCapabilities?.includes(
      ORCHESTRATION_EXTERNAL_COORDINATOR_RUNTIME_CAPABILITY
    ) ||
    evidence !== undefined
  ) {
    return undefined
  }
  return transport.authenticatedCallerFingerprint
}

/** The Run a request names, directly or through the message a reply answers. */
function requestedRunId(
  runtime: OrcaRuntimeService,
  method: string,
  params: CandidateParams
): string | undefined {
  if (typeof params.run === 'string' && params.run.length > 0) {
    return params.run
  }
  // A reply names its Run through the message it answers.
  return method === 'orchestration.reply' && typeof params.id === 'string'
    ? runtime.getOrchestrationDb().getMessageById(params.id)?.run_id
    : undefined
}

/** Undefined leaves every terminal, session, phone, SSH and ad-hoc caller on its existing path. */
export function createExternalCoordinatorInvocation(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  params: unknown,
  transport: ExternalCoordinatorTransport
): ExternalCoordinatorAuthority | undefined {
  const candidate: CandidateParams =
    typeof params === 'object' && params !== null && !Array.isArray(params) ? { ...params } : {}
  if (!isExternalCoordinatorCandidate(request.method, candidate)) {
    return undefined
  }
  const clientFingerprint = eligibleClientFingerprint(
    request.orchestrationCompatibilityEvidence,
    transport
  )
  if (!clientFingerprint) {
    if (request.method === 'orchestration.runCreate') {
      throw new OrchestrationError(
        'external_coordinator_unsupported',
        'run-create --external needs a saved runtime environment (orca environment add, then --environment <name>) that negotiated orchestration.external-coordinator.v1, run outside any Orca terminal or agent session. No effects were applied.',
        NO_EFFECTS
      )
    }
    return undefined
  }
  if (request.method === 'orchestration.runCreate') {
    return {
      kind: 'create',
      clientFingerprint,
      mutationCallerFingerprint: mutationFingerprint(clientFingerprint)
    }
  }
  const db = runtime.getOrchestrationDb()
  const runId = requestedRunId(runtime, request.method, candidate)
  const bound = db.runsBoundToExternalCoordinator(clientFingerprint)
  const run = runId ? bound.find((held) => held.id === runId) : bound[0]
  if (!run) {
    // Not coordinating, so receipts stay where this client wrote them before external coordinators existed.
    return { kind: 'unbound', clientFingerprint, mutationCallerFingerprint: clientFingerprint }
  }
  const revalidate = (): RunRow => {
    const current = db.getRun(run.id)
    if (
      !current ||
      current.consumer_generation !== run.consumer_generation ||
      currentRunExternalCoordinator(current) !== clientFingerprint
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        `This external coordinator is no longer bound to Run ${run.id}. No effects were applied.`,
        NO_EFFECTS
      )
    }
    return current
  }
  return {
    kind: 'bound',
    clientFingerprint,
    run,
    mutationCallerFingerprint: mutationFingerprint(clientFingerprint, run),
    revalidate
  }
}

/** Partitions this client's external mutations wrote receipts under, so request-show finds what a retry would replay. */
export function externalCoordinatorReceiptCallerFingerprints(
  runtime: OrcaRuntimeService,
  evidence: OrchestrationCompatibilityEvidence | undefined,
  transport: ExternalCoordinatorTransport
): string[] {
  const clientFingerprint = eligibleClientFingerprint(evidence, transport)
  if (!clientFingerprint) {
    return []
  }
  return [
    mutationFingerprint(clientFingerprint),
    ...runtime
      .getOrchestrationDb()
      .runsBoundToExternalCoordinator(clientFingerprint)
      .map((run) => mutationFingerprint(clientFingerprint, run))
  ]
}

/** The Run an external coordinator's request acts on; `explicit` is the Run it named, if any. */
export function externalCoordinatorRun(
  authority: ExternalCoordinatorAuthority,
  explicit: RunRow | undefined
): RunRow {
  if (authority.kind === 'bound' && (!explicit || explicit.id === authority.run.id)) {
    return authority.revalidate()
  }
  if (explicit) {
    throw new OrchestrationError(
      'consumer_fenced',
      `This external coordinator is not bound to Run ${explicit.id}. Nothing changed.`,
      NO_EFFECTS
    )
  }
  throw new OrchestrationError(
    'run_required',
    'No Run is bound to this external coordinator. Create one with `orchestration run-create --external`. No effects were applied.',
    orchestrationSkillRecoveryData()
  )
}
