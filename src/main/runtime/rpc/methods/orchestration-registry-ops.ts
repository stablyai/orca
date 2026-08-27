import { z } from 'zod'
import { getAppEnvironment } from '../../../../shared/app-environment'
import {
  admitCertificationEvidence,
  buildCertificationMatrix
} from '../../orchestration/control-plane/certification-admission'
import {
  buildRouteRow,
  findRegistryDrift
} from '../../orchestration/control-plane/route-registry-discovery'
import { RouteRegistryStore } from '../../orchestration/control-plane/route-registry-store'
import type { RouteIdentity } from '../../orchestration/control-plane/route-registry-types'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

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

const RoutesParams = z.object({ sha: OptionalString })

/** B1 (correction 2) — the bounded typed operations that register registry rows
 *  and certification evidence, and read back the role matrix. */
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

  defineMethod({
    name: 'orchestration.certify',
    params: CertifyParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
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
          runtimeVersion: getAppEnvironment().getVersion()
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
          currentRuntimeVersion: getAppEnvironment().getVersion()
        })
      }
    }
  })
]
