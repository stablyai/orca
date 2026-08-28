import { z } from 'zod'
import {
  admitCertificationEvidence,
  buildCertificationMatrix
} from '../../orchestration/control-plane/certification-admission'
import {
  buildRouteRow,
  findRegistryDrift
} from '../../orchestration/control-plane/route-registry-discovery'
import { readObservedLaunchIdentity } from '../../orchestration/control-plane/certification-event-source'
import { MUTATION_VERDICT_METHOD } from './orchestration-pretool-receipt'
import { mintCertificationIntent } from '../../orchestration/control-plane/certification-intent'
import { readPretoolVerdict } from '../../orchestration/control-plane/pretool-receipt'
import { observeAndPersistProviderIdentity } from '../../orchestration/control-plane/provider-session-identity'
import { readSafeLaunchAdmission } from '../../orchestration/control-plane/route-runtime-events'
import { requireCallerOwnedRunTask } from './orchestration-run-scope'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { assertDisposableCertificationWorkspace } from '../../orchestration/control-plane/certification-workspace-isolation'
import {
  classifyNativeRoute,
  ROUTE_TRUTH_SCHEMA_VERSION
} from '../../../../shared/native-route-contract'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { RouteRegistryStore } from '../../orchestration/control-plane/route-registry-store'
import type { RouteIdentity } from '../../orchestration/control-plane/route-registry-types'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { isCertifiableRuntimeBuildIdentity } from '../../orchestration/control-plane/runtime-build-identity'

const RouteIdentityParams = {
  agent: requiredString('Missing --agent'),
  model: OptionalString,
  reasoning: OptionalString
}

const CsvList = OptionalString

function toIdentity(params: { agent: string; model?: string; reasoning?: string }): RouteIdentity {
  return {
    agent: params.agent as RouteIdentity['agent'],
    model: params.model ?? null,
    reasoning: params.reasoning ?? null
  }
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

const RouteUpsertParams = z.object({
  ...RouteIdentityParams,
  provider: OptionalString,
  harness: OptionalString,
  roles: CsvList,
  capabilities: CsvList,
  sessionModes: CsvList,
  costClass: OptionalString,
  notes: OptionalString
})

const CertifyParams = z.object({
  ...RouteIdentityParams,
  role: z.enum(['builder', 'reviewer']),
  sessionMode: z.enum(['fresh', 'retained']),
  kind: requiredString('Missing --kind'),
  outcome: z.enum(['PASS', 'FAIL', 'UNSUPPORTED']),
  dispatch: OptionalString,
  sha: requiredString('Missing --sha'),
  detail: OptionalString
})

const RouteTruthParams = z.object({
  agent: requiredString('Missing --agent'),
  model: OptionalString,
  reasoning: OptionalString
})

const RoutesParams = z.object({ sha: OptionalString })

/** B1 (correction 2) — the bounded typed operations that register registry rows
 *  and certification evidence, and read back the role matrix. */
/** Refused rather than coerced: an intent for an agent Orca cannot launch would
 *  authorise a launch that can never happen. */
function assertTuiAgent(agent: string): TuiAgent {
  if (!isTuiAgent(agent)) {
    throw new OrchestrationError('route_unsupported', `${agent} is not an agent Orca can launch.`)
  }
  return agent
}

export const ORCHESTRATION_REGISTRY_OPS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.routeUpsert',
    params: RouteUpsertParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const store = new RouteRegistryStore(db)
      // Why buildRouteRow: launcher support, hook support, identity proof and
      // reasoning modes are DISCOVERED from the authoritative catalogs; the
      // caller may declare only eligibility and descriptive fields.
      const route = buildRouteRow({
        identity: toIdentity(params),
        provider: params.provider,
        harness: params.harness,
        roles: splitCsv(params.roles) as ('builder' | 'reviewer')[],
        taskCapabilities: splitCsv(params.capabilities),
        sessionModes: splitCsv(params.sessionModes) as ('fresh' | 'retained')[],
        costClass: params.costClass,
        notes: params.notes ?? null
      })
      store.upsertRoute(route)
      return { route, drift: findRegistryDrift([route]) }
    }
  }),

  MUTATION_VERDICT_METHOD,
  defineMethod({
    name: 'orchestration.certify',
    params: CertifyParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const build = runtime.getBuildIdentity()
      if (params.outcome === 'PASS' && !isCertifiableRuntimeBuildIdentity(build)) {
        throw new OrchestrationError(
          'runtime_build_unverifiable',
          'PASS evidence requires a clean embedded source SHA and a verified complete artifact manifest.'
        )
      }
      const admission = admitCertificationEvidence({
        db,
        request: {
          identity: toIdentity(params),
          role: params.role,
          sessionMode: params.sessionMode,
          kind: params.kind,
          outcome: params.outcome,
          dispatchId: params.dispatch,
          commitSha: params.sha,
          detail: params.detail ?? null
        },
        stamp: {
          // Why runtime-stamped: an evidence timestamp or version the caller
          // supplied would let a stale or fabricated run look current.
          observedAtIso: new Date().toISOString(),
          // Why version+buildHash: a version alone repeats across builds, so
          // evidence from another build of the same version would read current.
          runtimeVersion: build.id,
          commitSha: build.commitSha
        },
        // Why the runtime's own signals: the caller names the kind, the runtime
        // decides whether its records actually show that event happening.
        source: {
          // Prefer an independently observed launch receipt; otherwise read what
          // the PROVIDER itself reported through its own hook. Both are the
          // runtime's records; neither is the request copied back.
          // Why observe here too and not only in the liveness sweep: the sweep
          // runs while a coordinator waits, which may never have happened for a
          // Dispatch being certified. Observing on read makes the identity depend
          // on what the provider stated, not on whether a sweep was scheduled.
          // It is persisted the first time, so the transcript is read once.
          observedEffectiveIdentity: (dispatchId) =>
            readObservedLaunchIdentity(db, dispatchId) ??
            observeAndPersistProviderIdentity({
              db,
              dispatchId,
              snapshot: runtime.getOrchestrationLivenessSignalSource().agentStatusSnapshot()
            }),
          agentStatusSnapshot: () =>
            runtime.getOrchestrationLivenessSignalSource().agentStatusSnapshot(),
          // Only an explicit decision the policy path recorded. A PreTool hook
          // event proves a tool was seen, not that anything accepted it, and the
          // hook can fire before any decision exists.
          pretoolDecision: (dispatchId) =>
            readPretoolVerdict(db, { dispatchId, buildId: build.id }),
          safeLaunchAdmission: (dispatchId) => readSafeLaunchAdmission(db, dispatchId)
        }
      })
      if (!admission.ok) {
        throw new OrchestrationError(admission.code, admission.reason)
      }
      new RouteRegistryStore(db).recordRouteEvidence(admission.evidence)
      return { evidence: admission.evidence }
    }
  }),

  defineMethod({
    name: 'orchestration.routeTruth',
    params: RouteTruthParams,
    handler: (params, { runtime }) => {
      if (!isTuiAgent(params.agent)) {
        throw new OrchestrationError(
          'invalid_argument',
          `${params.agent} is not an agent this Orca knows how to launch.`
        )
      }
      // Why this exists: every launcher, hook policy and admission check that
      // keeps its OWN agent/model allowlist eventually disagrees with what Orca
      // can actually launch. This is the derivable answer they should read
      // instead, so no hand-maintained table has to be kept in sync by anyone.
      const classification = classifyNativeRoute({
        agent: params.agent,
        model: params.model ?? null,
        reasoning: params.reasoning ?? null
      })
      // Why the envelope: a consumer outside this repo — the SCL PreTool policy,
      // the safe launcher — has to know WHICH contract it is reading and WHICH
      // build answered, or it will keep a stale answer past the build that
      // produced it. Both are runtime-owned; neither can be asserted by a caller.
      const build = runtime.getBuildIdentity()
      return {
        schemaVersion: ROUTE_TRUTH_SCHEMA_VERSION,
        build: {
          id: build.id,
          version: build.version,
          buildHash: build.buildHash,
          commitSha: build.commitSha,
          provenanceSource: build.provenanceSource
        },
        agent: params.agent,
        model: params.model ?? null,
        reasoning: params.reasoning ?? null,
        verdict: classification.verdict,
        reason: classification.reason,
        capability: classification.capability
      }
    }
  }),

  defineMethod({
    name: 'orchestration.certificationIntent',
    params: z.object({
      run: requiredString('--run'),
      task: requiredString('--task'),
      worktree: requiredString('--worktree'),
      agent: requiredString('--agent'),
      model: OptionalString,
      reasoning: OptionalString,
      retryOf: OptionalString,
      from: OptionalString
    }),
    handler: async (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const store = new ControlPlaneStore(db)
      const build = runtime.getBuildIdentity()
      if (!isCertifiableRuntimeBuildIdentity(build)) {
        throw new OrchestrationError(
          'runtime_build_unverifiable',
          'Certification intent requires a clean embedded source SHA and a verified complete artifact manifest.'
        )
      }
      // Naming an admitted Run is not authority over it. The mint requires the
      // same ownership worker-start requires: the caller's own pane must be the
      // coordinator currently bound to this Run, and the Task must belong to it.
      const { run } = requireCallerOwnedRunTask(runtime, db, {
        from: params.from,
        run: params.run,
        task: params.task,
        callerEvidence: orchestrationCompatibilityEvidence,
        verb: 'Minting a certification intent'
      })
      // This used to require the named worktree to BE the coordinator's own
      // checkout. That is what put certification workers in the implementation
      // worktree, where two of them committed to the source branch and destroyed
      // the principal's uncommitted work. The requirement is now the opposite: a
      // real workspace this runtime knows, and never the coordinator's own.
      const namedWorkspace = await runtime
        .showManagedTerminalWorkspace(params.worktree)
        .catch(() => null)
      if (!namedWorkspace) {
        throw new OrchestrationError(
          'worktree_not_found',
          `Worktree ${params.worktree} is not a workspace this Orca knows, so no certification worker can be placed in it.`
        )
      }
      const callerWorktree = run.coordinator_handle
        ? await runtime.showTerminal(run.coordinator_handle).catch(() => null)
        : null
      assertDisposableCertificationWorkspace({
        intentWorktreeId: namedWorkspace.id,
        coordinatorWorktreeId: callerWorktree?.worktreeId ?? null
      })
      const outcome = store.getOutcomeByRun(params.run)
      if (!outcome) {
        throw new OrchestrationError(
          'outcome_not_admitted',
          `Run ${params.run} has no admitted outcome, so there is nothing to certify against.`
        )
      }
      // Bound to the runtime's OWN build, so an intent cannot outlive the
      // artifact whose route it was issued to prove.
      const intent = mintCertificationIntent(
        db,
        {
          runId: params.run,
          taskId: params.task,
          outcomeId: outcome.outcome_id,
          // The RESOLVED id, not the caller's selector: admission compares against
          // what the runtime resolved, so storing 'current' guaranteed a mismatch.
          worktreeId: namedWorkspace.id,
          identity: {
            agent: assertTuiAgent(params.agent),
            model: params.model ?? null,
            reasoning: params.reasoning ?? null
          },
          buildId: build.id,
          retryOfDispatchId: params.retryOf ?? null
        },
        new Date().toISOString()
      )
      return { intent }
    }
  }),
  defineMethod({
    name: 'orchestration.routes',
    params: RoutesParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const store = new RouteRegistryStore(db)
      const routes = store.listRoutes()
      return {
        routes,
        drift: findRegistryDrift(routes),
        matrix: buildCertificationMatrix({
          db,
          nowMs: Date.now(),
          currentCommitSha: params.sha,
          // .id, not .version: certify stamps evidence with the full build
          // identity (version+buildHash+commit). Comparing against the bare
          // version means no evidence ever matches the runtime that recorded it,
          // so a fully certified route reads STALE forever.
          currentRuntimeVersion: runtime.getBuildIdentity().id
        })
      }
    }
  })
]
