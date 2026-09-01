// The single host boundary every agent spawn routes through (U3). It sequences
// the launch pipeline exactly per plan §3's admission paragraph: resolve once
// from an atomic host view, run trust/provider-env preparation OUTSIDE the
// admission coordinator, then INSIDE the coordinator re-take the host view,
// recompute the relevant-input fingerprint, and commit the admitted token/
// snapshot before any provider I/O. The startup plan is built from the ORIGINAL
// resolved launch: admission commits that snapshot and later edits affect only
// future launches. Dependency-injected and electron-free so it is unit-testable.

import type {
  AdmissionCapacityRow,
  AdmissionPrincipal,
  AgentLaunchAdmissionStore,
  AdmittedLaunchRecord,
  LaunchAdmissionCoordinator
} from './agent-launch-admission-store'
import type { ResolvedAgentLaunch } from '../../shared/agent-launch-host-contract'
import type {
  AgentLaunchFailure,
  AgentLaunchRequestError
} from '../../shared/agent-launch-contract'
import { buildAgentStartupPlanFromResolvedLaunch } from '../../shared/resolved-agent-startup-plan'
import {
  agentIds,
  dedupeNoticesByCode,
  mapAdmissionMismatch,
  resolveAgentLaunchPlanWithoutAdmission,
  type ExecuteAgentLaunchArgs,
  type ExecuteAgentLaunchResult,
  type ExecuteReservedAgentLaunchArgs,
  type LaunchSettlement,
  type PrepareReservedAgentLaunchArgs,
  type PrepareReservedAgentLaunchResult,
  type ResolveAgentLaunchPlanArgs,
  type ResolveAgentLaunchPlanResult
} from './agent-launch-boundary-contract'

// Re-export the boundary contract so existing importers keep a single entry.
export * from './agent-launch-boundary-contract'

// The registration reader consumes a retained record right after the
// 'registered' settle; the bound only caps records whose reader never came, so
// a long-lived host can't accumulate one argv+env record per launch forever.
const MAX_RETAINED_LAUNCH_RECORDS = 64

type CriticalResult =
  | { kind: 'admitted'; record: AdmittedLaunchRecord; catalogRevision: number }
  | { kind: 'failure'; failure: AgentLaunchFailure }
  | { kind: 'requestError'; requestError: AgentLaunchRequestError }

export class AgentLaunchBoundary {
  private readonly admissionStore: AgentLaunchAdmissionStore
  private readonly coordinator: LaunchAdmissionCoordinator
  private readonly now: () => number
  /** Private registration handoff for registered launches, read by
   *  registerHostSessionLaunch. Bounded (FIFO) and dropped on a 'failed'
   *  settle so it cannot grow unbounded. Never serialized to clients/logs. */
  private readonly retained = new Map<string, AdmittedLaunchRecord>()

  constructor(deps: {
    admissionStore: AgentLaunchAdmissionStore
    coordinator: LaunchAdmissionCoordinator
    now?: () => number
  }) {
    this.admissionStore = deps.admissionStore
    this.coordinator = deps.coordinator
    this.now = deps.now ?? (() => Date.now())
  }

  async executeAgentLaunch(args: ExecuteAgentLaunchArgs): Promise<ExecuteAgentLaunchResult> {
    const nowFn = args.now ?? this.now
    const initial = args.resolve()
    if (!initial.outcome.ok) {
      if ('requestError' in initial.outcome) {
        return { ok: false, requestError: initial.outcome.requestError }
      }
      return { ok: false, failure: initial.outcome.failure }
    }
    const original = initial.outcome.launch
    const originalFingerprint = original.admissionGuard.fingerprint

    const prepFailure = await this.runPreparation(args, original)
    if (prepFailure) {
      return { ok: false, failure: prepFailure }
    }

    const result = await this.coordinator.runExclusive<CriticalResult>(() =>
      this.admitInsideCoordinator(args.resolve, original, originalFingerprint, () =>
        this.admissionStore.admit({
          principal: args.principal,
          intent: original.policy.intent,
          scope: args.scope,
          worktreeId: args.worktreeId ?? null,
          fingerprint: originalFingerprint,
          snapshot: original.snapshot,
          admittedAt: nowFn()
        })
      )
    )
    if (result.kind === 'requestError') {
      return { ok: false, requestError: result.requestError }
    }
    if (result.kind === 'failure') {
      return { ok: false, failure: result.failure }
    }

    return this.finalizeAdmittedLaunch(
      args,
      original,
      result.record.launchToken,
      result.catalogRevision
    )
  }

  /** Build the startup plan from the ORIGINAL admitted launch and assemble the
   *  receipt. Shared by the single-shot and two-stage paths. A null plan
   *  (nothing launchable) releases the admitted token rather than stranding it. */
  private finalizeAdmittedLaunch(
    args: ExecuteAgentLaunchArgs,
    original: ResolvedAgentLaunch,
    token: string,
    catalogRevision: number
  ): ExecuteAgentLaunchResult {
    const plan = buildAgentStartupPlanFromResolvedLaunch({
      launch: original,
      prompt: args.prompt,
      ...(args.allowEmptyPromptLaunch !== undefined
        ? { allowEmptyPromptLaunch: args.allowEmptyPromptLaunch }
        : {}),
      ...(args.promptDelivery !== undefined ? { promptDelivery: args.promptDelivery } : {}),
      ...(args.maxInlineDraftChars !== undefined
        ? { maxInlineDraftChars: args.maxInlineDraftChars }
        : {}),
      launchToken: token
    })
    if (!plan) {
      this.admissionStore.release(token)
      return {
        ok: false,
        failure: {
          code: 'no_agent_selected',
          requestedAgent: original.requestedAgent,
          baseAgent: original.baseAgent
        }
      }
    }
    return {
      ok: true,
      plan,
      receipt: {
        requestedAgent: original.requestedAgent,
        baseAgent: original.baseAgent,
        notices: dedupeNoticesByCode(original.notices),
        launchToken: token,
        catalogRevision,
        telemetry: original.telemetry
      }
    }
  }

  /** Resolve-only entry for the legacy renderer-spawned worktree-create startup
   *  path: it resolves once from the atomic host view and builds a plan, but
   *  never admits — that path registers no terminal receipt and has no settle
   *  seam, so an admitted hold would leak capacity forever. One-release
   *  compatibility code, deleted with the legacy startupAgent/startupDraft fields. */
  resolveAgentLaunchPlanWithoutAdmission(
    args: ResolveAgentLaunchPlanArgs
  ): ResolveAgentLaunchPlanResult {
    return resolveAgentLaunchPlanWithoutAdmission(args)
  }

  /** Pre-create stage of a two-stage worktree launch: resolve once to pin the
   *  concrete identity + capture the config-only digest, then take a capacity
   *  hold — all BEFORE git mutation so launch_capacity_exceeded precedes any
   *  side effect. The resolved argv is intentionally discarded; only the pinned
   *  identity + digest + reservation survive. */
  prepareReservedAgentLaunch(
    args: PrepareReservedAgentLaunchArgs
  ): PrepareReservedAgentLaunchResult {
    const resolution = args.resolve()
    if (!resolution.outcome.ok) {
      if ('requestError' in resolution.outcome) {
        return { ok: false, requestError: resolution.outcome.requestError }
      }
      return { ok: false, failure: resolution.outcome.failure }
    }
    const reservation = this.admissionStore.reserve(args.principal)
    if (!reservation.ok) {
      return { ok: false, failure: reservation.failure }
    }
    const launch = resolution.outcome.launch
    return {
      ok: true,
      reservationId: reservation.reservation.reservationId,
      requestedAgent: launch.requestedAgent,
      baseAgent: launch.baseAgent,
      stableInputDigest: launch.admissionGuard.stableInputDigest
    }
  }

  /** Post-create stage: resolve with authoritative paths and the pinned
   *  identity, recheck the config-only digest against the pin (a mismatch is a
   *  config change across the git operation → agent_configuration_changed), then
   *  convert the held reservation to a token/snapshot inside the coordinator.
   *  The reservation is released on EVERY post-reserve exit so a failed launch
   *  never permanently burns capacity. */
  async executeReservedAgentLaunch(
    args: ExecuteReservedAgentLaunchArgs
  ): Promise<ExecuteAgentLaunchResult> {
    const nowFn = args.now ?? this.now
    const initial = args.resolve()
    if (!initial.outcome.ok) {
      this.admissionStore.releaseReservation(args.reservationId)
      if ('requestError' in initial.outcome) {
        return { ok: false, requestError: initial.outcome.requestError }
      }
      return { ok: false, failure: initial.outcome.failure }
    }
    const original = initial.outcome.launch
    if (original.admissionGuard.stableInputDigest !== args.expectedStableInputDigest) {
      this.admissionStore.releaseReservation(args.reservationId)
      return { ok: false, failure: { code: 'agent_configuration_changed', ...agentIds(original) } }
    }

    const prepFailure = await this.runPreparation(args, original)
    if (prepFailure) {
      this.admissionStore.releaseReservation(args.reservationId)
      return { ok: false, failure: prepFailure }
    }

    const originalFingerprint = original.admissionGuard.fingerprint
    const result = await this.coordinator.runExclusive<CriticalResult>(() =>
      this.admitInsideCoordinator(args.resolve, original, originalFingerprint, () =>
        this.admissionStore.admitReserved(args.reservationId, {
          intent: original.policy.intent,
          scope: args.scope,
          worktreeId: args.worktreeId ?? null,
          fingerprint: originalFingerprint,
          snapshot: original.snapshot,
          admittedAt: nowFn()
        })
      )
    )
    if (result.kind === 'requestError') {
      this.admissionStore.releaseReservation(args.reservationId)
      return { ok: false, requestError: result.requestError }
    }
    if (result.kind === 'failure') {
      // admitReserved was either never reached (fingerprint mismatch) or failed;
      // the hold is still ours to release.
      this.admissionStore.releaseReservation(args.reservationId)
      return { ok: false, failure: result.failure }
    }
    // admitReserved consumed the reservation into result.record's token.
    return this.finalizeAdmittedLaunch(
      args,
      original,
      result.record.launchToken,
      result.catalogRevision
    )
  }

  /** Drop a held pre-create reservation when the caller aborts BEFORE
   *  executeReservedAgentLaunch — e.g. the git worktree creation threw between
   *  prepare and execute. Frees the capacity a leaked hold would burn forever. */
  releaseReservedAgentLaunch(reservationId: string): void {
    this.admissionStore.releaseReservation(reservationId)
  }

  /** Move or release the admission reservation once the caller's writer settled.
   *  Registered retains a private handoff record; failed releases entirely. */
  settleAgentLaunch(launchToken: string, settlement: LaunchSettlement): void {
    if (settlement === 'registered') {
      const record = this.admissionStore.get(launchToken)
      if (record) {
        this.retained.set(launchToken, record)
        // FIFO-evict oldest handoffs past the bound; anything that old was
        // never read by its registration and would otherwise leak forever.
        while (this.retained.size > MAX_RETAINED_LAUNCH_RECORDS) {
          const oldest = this.retained.keys().next().value
          if (oldest === undefined) {
            break
          }
          this.retained.delete(oldest)
        }
      }
    } else {
      // A later 'failed' settle (e.g. exit reconciliation) ends the handoff's
      // usefulness; drop it so failed launches never pin argv/env records.
      this.retained.delete(launchToken)
    }
    this.admissionStore.release(launchToken)
  }

  /** Private reconciliation lookup; never returned to clients. */
  retainedFor(launchToken: string): AdmittedLaunchRecord | null {
    return this.retained.get(launchToken) ?? null
  }

  /** Host-only accessor for the admitted-but-unsettled snapshot, so the created-
   *  path transition can persist it into the private pending-snapshot store in the
   *  same write as the public pending metadata. Never serialized to clients/logs. */
  pendingSnapshotFor(launchToken: string): AdmittedLaunchRecord['snapshot'] | null {
    return this.admissionStore.get(launchToken)?.snapshot ?? null
  }

  /** Redacted capacity-recovery rows for the pending-summary surface, filtered to
   *  the caller's own principal. Keeps the admission store private; the runtime
   *  drops the launch token before projecting to the client DTO. */
  capacitySummaryFor(principal: AdmissionPrincipal): AdmissionCapacityRow[] {
    return this.admissionStore.capacitySummaryFor(principal)
  }

  /** Boot-time rehydrate of the admission capacity that durable pending launches
   *  held before a restart, so caps keep counting launch_state_unknown launches
   *  and Forget's release frees a real slot. Never called mid-flight. */
  rebuildAdmissionFrom(records: Iterable<AdmittedLaunchRecord>): void {
    this.admissionStore.rebuildFrom(records)
  }

  private async runPreparation(
    args: ExecuteAgentLaunchArgs,
    original: ResolvedAgentLaunch
  ): Promise<AgentLaunchFailure | null> {
    const preflightFailure = { code: 'trust_preflight_failed' as const, ...agentIds(original) }
    if (args.preflight) {
      try {
        await args.preflight(original)
      } catch {
        return preflightFailure
      }
    }
    if (args.prepareEnv) {
      try {
        await args.prepareEnv(original)
      } catch {
        return preflightFailure
      }
    }
    return null
  }

  /** Coordinator critical section shared by the single-shot and two-stage
   *  paths: re-take the atomic host view, recheck the relevant-input
   *  fingerprint, then run the store admit step. No trust/fs/network/provider
   *  I/O runs here. On the two-stage path a mismatch leaves the reservation
   *  intact for the caller to release. */
  private admitInsideCoordinator(
    resolve: () => ReturnType<ExecuteAgentLaunchArgs['resolve']>,
    original: ResolvedAgentLaunch,
    originalFingerprint: string,
    admit: () => ReturnType<AgentLaunchAdmissionStore['admit']>
  ): CriticalResult {
    const reResolution = resolve()
    if (!reResolution.outcome.ok) {
      if ('requestError' in reResolution.outcome) {
        return { kind: 'requestError', requestError: reResolution.outcome.requestError }
      }
      return { kind: 'failure', failure: mapAdmissionMismatch(reResolution.outcome.failure) }
    }
    if (reResolution.outcome.launch.admissionGuard.fingerprint !== originalFingerprint) {
      return {
        kind: 'failure',
        failure: { code: 'agent_configuration_changed', ...agentIds(original) }
      }
    }
    const admission = admit()
    if (!admission.ok) {
      return { kind: 'failure', failure: admission.failure }
    }
    return {
      kind: 'admitted',
      record: admission.record,
      catalogRevision: reResolution.catalogRevision
    }
  }
}
