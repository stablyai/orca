import type {
  LegacyAdoptionRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_RUN_ID, LEGACY_CONTRACT_VERSION } from '../contract-constants'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

// ── Legacy adoption and compatibility principals ──

export function getLegacyAdoption(this: OrchestrationDb): LegacyAdoptionRow | undefined {
  return this.db
    .prepare('SELECT * FROM legacy_adoptions WHERE source_run_id = ?')
    .get(LEGACY_RUN_ID) as LegacyAdoptionRow | undefined
}

export function commitLegacyCompatibilityPrincipal(
  this: OrchestrationDb,
  params: {
    runId: string
    dispatchId?: string
    role: LegacyPrincipalRole
    hostScope: string
    terminalHandle: string
    paneKey: string
    launchTokenHash: string
    processIncarnation?: string
  }
): { principal: LegacyCompatibilityPrincipalRow; duplicate: boolean } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const adoption = this.getLegacyAdoption()
    if (!adoption || adoption.adopted_run_id !== params.runId) {
      throw new OrchestrationError(
        'request_mismatch',
        `Run ${params.runId} is not the adopted legacy Run.`
      )
    }
    const dispatchId = params.role === 'worker' ? (params.dispatchId ?? null) : null
    let initialStatus: 'committed' | 'settled' = 'committed'
    if (params.role === 'worker') {
      const dispatch = dispatchId ? this.getDispatchContextById(dispatchId) : undefined
      if (
        !dispatch ||
        dispatch.run_id !== params.runId ||
        dispatch.contract_version !== LEGACY_CONTRACT_VERSION
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Dispatch ${dispatchId ?? '(missing)'} is not a legacy attempt in this Run.`
        )
      }
      initialStatus = ['pending', 'dispatched'].includes(dispatch.status) ? 'committed' : 'settled'
    } else if (params.dispatchId) {
      throw new OrchestrationError(
        'request_mismatch',
        'A coordinator compatibility principal cannot name a Dispatch.'
      )
    }

    const existing = this.db
      .prepare(
        `SELECT * FROM legacy_compatibility_principals
         WHERE role = ? AND run_id = ? AND dispatch_id IS ?`
      )
      .get(params.role, params.runId, dispatchId) as LegacyCompatibilityPrincipalRow | undefined
    if (existing) {
      const same =
        existing.host_scope === params.hostScope &&
        existing.terminal_handle === params.terminalHandle &&
        existing.pane_key === params.paneKey &&
        existing.launch_token_hash === params.launchTokenHash &&
        existing.process_incarnation === (params.processIncarnation ?? null)
      if (!same) {
        throw new OrchestrationError(
          'request_mismatch',
          `The ${params.role} compatibility principal is already committed to different proof.`
        )
      }
      if (existing.status === 'revoked') {
        throw new OrchestrationError(
          'legacy_read_only',
          `The ${params.role} compatibility principal has been revoked. No effects were applied.`,
          { effectsApplied: false }
        )
      }
      this.db.exec('COMMIT')
      return { principal: existing, duplicate: true }
    }
    if (
      params.role === 'coordinator' &&
      !this.resolveLegacyCoordinatorCandidate({
        runId: params.runId,
        terminalHandle: params.terminalHandle,
        paneKey: params.paneKey
      })
    ) {
      throw new OrchestrationError(
        'legacy_read_only',
        'This retained legacy coordinator no longer has lifecycle authority. No effects were applied.',
        { effectsApplied: false }
      )
    }

    const id = generateId('legacy_principal')
    this.db
      .prepare(
        `INSERT INTO legacy_compatibility_principals (
           id, run_id, dispatch_id, role, host_scope, terminal_handle,
           pane_key, launch_token_hash, process_incarnation, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.runId,
        dispatchId,
        params.role,
        params.hostScope,
        params.terminalHandle,
        params.paneKey,
        params.launchTokenHash,
        params.processIncarnation ?? null,
        initialStatus
      )
    const principal = this.getLegacyCompatibilityPrincipal(id) as LegacyCompatibilityPrincipalRow
    if (principal.status === 'committed') {
      this.initializeLegacyRecoveryCohort(principal)
    }
    this.db.exec('COMMIT')
    return { principal, duplicate: false }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getLegacyCompatibilityPrincipal(
  this: OrchestrationDb,
  id: string
): LegacyCompatibilityPrincipalRow | undefined {
  return this.db.prepare('SELECT * FROM legacy_compatibility_principals WHERE id = ?').get(id) as
    | LegacyCompatibilityPrincipalRow
    | undefined
}

export function listLegacyCompatibilityPrincipals(
  this: OrchestrationDb,
  runId: string
): LegacyCompatibilityPrincipalRow[] {
  return this.db
    .prepare(
      `SELECT * FROM legacy_compatibility_principals
       WHERE run_id = ? ORDER BY rowid`
    )
    .all(runId) as LegacyCompatibilityPrincipalRow[]
}

export function getLegacyCoordinatorPrincipal(
  this: OrchestrationDb,
  runId: string
): LegacyCompatibilityPrincipalRow | undefined {
  return this.db
    .prepare(
      `SELECT * FROM legacy_compatibility_principals
       WHERE run_id = ? AND role = 'coordinator'`
    )
    .get(runId) as LegacyCompatibilityPrincipalRow | undefined
}

export type LegacyCompatibilityPrincipalsMethods = {
  getLegacyAdoption: typeof getLegacyAdoption
  commitLegacyCompatibilityPrincipal: typeof commitLegacyCompatibilityPrincipal
  getLegacyCompatibilityPrincipal: typeof getLegacyCompatibilityPrincipal
  listLegacyCompatibilityPrincipals: typeof listLegacyCompatibilityPrincipals
  getLegacyCoordinatorPrincipal: typeof getLegacyCoordinatorPrincipal
}

export function attachLegacyCompatibilityPrincipals(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getLegacyAdoption,
    commitLegacyCompatibilityPrincipal,
    getLegacyCompatibilityPrincipal,
    listLegacyCompatibilityPrincipals,
    getLegacyCoordinatorPrincipal
  })
}
