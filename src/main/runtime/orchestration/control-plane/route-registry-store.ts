import { ensureControlPlaneTables, type ControlPlaneDatabaseHandle } from './control-plane-store'
import type { RouteEvidence } from './route-certification-evidence'
import type {
  RouteReadiness,
  RouteRole,
  RouteRow,
  SessionMode,
  TaskCapability
} from './route-registry-types'
import { routeKey } from './route-registry-types'

/** Durable accessor for the B1 registry rows and their certification evidence.
 *  Separate from ControlPlaneStore so the registry can be read by admission
 *  without pulling in outcome, lease and gate state. */
export class RouteRegistryStore {
  private readonly handle: ControlPlaneDatabaseHandle

  constructor(handle: ControlPlaneDatabaseHandle) {
    this.handle = handle
    ensureControlPlaneTables(handle)
  }

  // --- B1 registry rows ---------------------------------------------------

  listRoutes(): RouteRow[] {
    const rows = this.handle.db
      .prepare('SELECT * FROM control_plane_routes ORDER BY route_key ASC')
      .all() as Record<string, unknown>[]
    return rows.map((row) => ({
      identity: {
        agent: row.agent as RouteRow['identity']['agent'],
        model: (row.model as string | null) ?? null,
        reasoning: (row.reasoning as string | null) ?? null
      },
      provider: row.provider as RouteRow['provider'],
      harness: row.harness as RouteRow['harness'],
      roles: JSON.parse(row.roles as string) as RouteRole[],
      taskCapabilities: JSON.parse(row.task_capabilities as string) as TaskCapability[],
      sessionModes: JSON.parse(row.session_modes as string) as SessionMode[],
      reasoningModes: JSON.parse(row.reasoning_modes as string) as string[],
      contextLimitTokens: parseContextLimit(row.context_limit_tokens as string),
      costClass: row.cost_class as RouteRow['costClass'],
      identityProof: row.identity_proof as RouteRow['identityProof'],
      launcherSupported: row.launcher_supported === 1,
      hookSupported: row.hook_supported === 1,
      readiness: JSON.parse(row.readiness as string) as RouteReadiness,
      constraints: JSON.parse(row.constraints_json as string) as string[],
      notes: (row.notes as string | null) ?? null
    }))
  }

  upsertRoute(route: RouteRow): void {
    this.handle.db
      .prepare(
        `INSERT INTO control_plane_routes
           (route_key, agent, model, reasoning, provider, harness, roles, task_capabilities,
            session_modes, reasoning_modes, context_limit_tokens, cost_class, identity_proof,
            launcher_supported, hook_supported, readiness, constraints_json, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(route_key) DO UPDATE SET
           provider = excluded.provider,
           harness = excluded.harness,
           roles = excluded.roles,
           task_capabilities = excluded.task_capabilities,
           session_modes = excluded.session_modes,
           reasoning_modes = excluded.reasoning_modes,
           context_limit_tokens = excluded.context_limit_tokens,
           cost_class = excluded.cost_class,
           identity_proof = excluded.identity_proof,
           launcher_supported = excluded.launcher_supported,
           hook_supported = excluded.hook_supported,
           readiness = excluded.readiness,
           constraints_json = excluded.constraints_json,
           notes = excluded.notes,
           updated_at = datetime('now')`
      )
      .run(
        routeKey(route.identity),
        route.identity.agent,
        route.identity.model,
        route.identity.reasoning,
        route.provider,
        route.harness,
        JSON.stringify(route.roles),
        JSON.stringify(route.taskCapabilities),
        JSON.stringify(route.sessionModes),
        JSON.stringify(route.reasoningModes),
        String(route.contextLimitTokens),
        route.costClass,
        route.identityProof,
        route.launcherSupported ? 1 : 0,
        route.hookSupported ? 1 : 0,
        JSON.stringify(route.readiness),
        JSON.stringify(route.constraints),
        route.notes
      )
  }

  // --- B1 certification evidence --------------------------------------------

  listRouteEvidence(routeKeyFilter?: string): RouteEvidence[] {
    const rows = (
      routeKeyFilter
        ? this.handle.db
            .prepare('SELECT * FROM control_plane_route_evidence WHERE route_key = ?')
            .all(routeKeyFilter)
        : this.handle.db.prepare('SELECT * FROM control_plane_route_evidence').all()
    ) as Record<string, unknown>[]
    return rows.map((row) => ({
      routeKey: row.route_key as string,
      kind: row.kind as RouteEvidence['kind'],
      role: row.role as RouteRole,
      sessionMode: row.session_mode as SessionMode,
      outcome: row.outcome as RouteEvidence['outcome'],
      observedAt: row.observed_at as string,
      runtimeVersion: row.runtime_version as string,
      commitSha: row.commit_sha as string,
      detail: (row.detail as string | null) ?? null
    }))
  }

  recordRouteEvidence(evidence: RouteEvidence): void {
    this.handle.db
      .prepare(
        `INSERT OR REPLACE INTO control_plane_route_evidence
           (route_key, kind, role, session_mode, outcome, observed_at, runtime_version, commit_sha, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        evidence.routeKey,
        evidence.kind,
        evidence.role,
        evidence.sessionMode,
        evidence.outcome,
        evidence.observedAt,
        evidence.runtimeVersion,
        evidence.commitSha,
        evidence.detail
      )
  }
}

function parseContextLimit(raw: string): RouteRow['contextLimitTokens'] {
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 'UNKNOWN'
}
