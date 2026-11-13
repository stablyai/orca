// EP-8: a cloud workspace's server refuses this computer's saved pairing (an owner change revoked
// its device, or a teammate's grant was revoked). Retrying the old token forever ("Reconnecting…",
// "rejected the pairing token") never recovers, so ask Orca Cloud for a fresh grant for this
// computer and swap it in on the same server. The server's own access check decides: the current
// owner or a member who can still see the workspace gets one; anyone else is refused and told so.
// A refusal is final for that pairing; a transient failure (the network, a 5xx) may try again a
// couple of times, spaced out, so a blip self-heals without a revoked device hammering the control
// plane (GRANT-ID-TRACKING). Every grant a recovery leaves this computer holding is remembered, so
// the next recovery revokes it instead of letting stray device grants pile up.

/** Only a real refusal of this computer's pairing re-grants; never timeouts or other errors. */
export function isPairingRejection(code: string | undefined, message: string): boolean {
  return (
    code === 'unauthorized' ||
    code === 'device_revoked' ||
    /rejected the pairing token/i.test(message)
  )
}

export type CloudPairingTarget = {
  sandboxId: string
  /** owned: this computer's own workspace (its VM's environment); paired: a teammate's (a binding). */
  kind: 'owned' | 'paired'
  /** The paired binding's current grant, revoked once a new one replaces it. */
  grantId: string | null
}

export type CloudPairingRecoveryDeps = {
  /** The cloud workspace behind a server environment, or null when it isn't one. */
  target: (environmentId: string) => Promise<CloudPairingTarget | null>
  /** The environment's current pairing revision (the guard key), or null when it no longer exists. */
  revision: (environmentId: string) => number | null
  openGrant: (
    sandboxId: string
  ) => Promise<
    | { ok: true; value: { grantId: string; pairingCode: string } }
    | { ok: false; status?: number; error: string }
  >
  /**
   * Swaps the pairing on the same environment (same host key only). `wrong_server`: the fresh grant
   * is for a host that isn't the one this environment paired with, which no retry can fix.
   */
  repair: (environmentId: string, pairingCode: string) => Promise<CloudPairingRepair>
  bind: (sandboxId: string, environmentId: string, grantId: string) => Promise<void>
  revokeGrant: (sandboxId: string, grantId: string) => Promise<void>
  invalidate: (environmentId: string) => Promise<void> | void
  /** The account can no longer open it: tell the window (one clear action there). */
  onAccessLost: (environmentId: string, sandboxId: string) => void
  /**
   * The grant an earlier recovery left this computer holding for a sandbox that no binding tracks
   * (an owned workspace, or a paired one whose binding couldn't be updated); null when none.
   */
  recordedGrant: (sandboxId: string) => Promise<string | null>
  recordGrant: (sandboxId: string, grantId: string | null) => Promise<void>
  now?: () => number
}

/** Attempts per saved pairing: the first, then two retries after transient failures. */
export const MAX_RECOVERY_ATTEMPTS = 3
/** Wait before each retry (after the 1st and 2nd failed attempts). */
export const RECOVERY_RETRY_DELAYS_MS = [30_000, 120_000] as const

export type CloudPairingRepair = 'saved' | 'wrong_server' | 'failed'

export type CloudPairingRecoveryOutcome =
  | 'not_cloud'
  | 'already_tried'
  | 'repaired'
  | 'access_lost'
  | 'failed'
  /** Transient failure; another refusal after the wait may try again. */
  | 'retry_later'

export function createCloudPairingRecovery(deps: CloudPairingRecoveryDeps) {
  const now = deps.now ?? Date.now
  /** Per saved pairing: attempts made, when a retry may start, and whether it's settled for good. */
  const attempts = new Map<string, { count: number; retryAt: number; final: boolean }>()
  const running = new Map<string, Promise<CloudPairingRecoveryOutcome>>()

  const revoke = (sandboxId: string, grantId: string | null): Promise<void> =>
    grantId ? deps.revokeGrant(sandboxId, grantId).catch(() => undefined) : Promise.resolve()

  /**
   * Grants whose write to disk failed: still tracked for this run, so the next recovery revokes them.
   * (The new grant is the one the repaired pairing is using, so it can't be revoked instead.)
   */
  const unsaved = new Map<string, string | null>()

  /** Keep the new grant tracked; revoke the one an earlier recovery left behind, if different. */
  async function track(sandboxId: string, grantId: string | null): Promise<void> {
    const previous = unsaved.has(sandboxId)
      ? (unsaved.get(sandboxId) ?? null)
      : await deps.recordedGrant(sandboxId).catch(() => null)
    try {
      await deps.recordGrant(sandboxId, grantId)
      unsaved.delete(sandboxId)
    } catch (error) {
      unsaved.set(sandboxId, grantId)
      // Ids only (not secrets): after a restart this grant would no longer be tracked.
      console.warn('[cloud-pairing-recovery] could not save the tracked grant:', sandboxId, error)
    }
    if (previous && previous !== grantId) {
      await revoke(sandboxId, previous)
    }
  }

  async function attempt(
    environmentId: string,
    transient: () => CloudPairingRecoveryOutcome
  ): Promise<CloudPairingRecoveryOutcome> {
    const target = await deps.target(environmentId)
    if (!target) {
      return 'not_cloud'
    }
    const grant = await deps.openGrant(target.sandboxId)
    if (!grant.ok) {
      // Not found / forbidden: the server says this account can't open it any more.
      if (grant.status === 404 || grant.status === 403) {
        deps.onAccessLost(environmentId, target.sandboxId)
        return 'access_lost'
      }
      return transient()
    }
    // A repair that throws (the ticket exchange can fail on the network) counts as not saved.
    const repaired = await deps
      .repair(environmentId, grant.value.pairingCode)
      .catch((): CloudPairingRepair => 'failed')
    if (repaired !== 'saved') {
      // The fresh grant is unused here: never leave it behind as a stray device.
      await revoke(target.sandboxId, grant.value.grantId)
      // A different server will never match: final, like a refusal. Anything else may retry.
      return repaired === 'wrong_server' ? 'failed' : transient()
    }
    if (target.kind === 'owned') {
      // No binding tracks an owned workspace's grant: remember it, so the next recovery revokes it.
      await track(target.sandboxId, grant.value.grantId)
    } else {
      const bound = await deps
        .bind(target.sandboxId, environmentId, grant.value.grantId)
        .then(() => true)
        .catch(() => false)
      // Bound: the binding tracks the new grant (and nothing else needs remembering). Not bound:
      // the binding still names the old grant, so remember the new one here instead.
      await track(target.sandboxId, bound ? null : grant.value.grantId)
      if (target.grantId && target.grantId !== grant.value.grantId) {
        await revoke(target.sandboxId, target.grantId)
      }
    }
    await deps.invalidate(environmentId)
    return 'repaired'
  }

  async function recover(environmentId: string): Promise<CloudPairingRecoveryOutcome> {
    const revision = deps.revision(environmentId)
    if (revision === null) {
      return 'not_cloud'
    }
    const key = `${environmentId}:${revision}`
    const state = attempts.get(key) ?? { count: 0, retryAt: 0, final: false }
    if (state.final || state.count >= MAX_RECOVERY_ATTEMPTS || now() < state.retryAt) {
      return 'already_tried'
    }
    state.count += 1
    attempts.set(key, state)
    const outcome = await attempt(environmentId, () => {
      const delay = RECOVERY_RETRY_DELAYS_MS[state.count - 1]
      if (delay === undefined) {
        return 'failed'
      }
      state.retryAt = now() + delay
      return 'retry_later'
    })
    if (outcome !== 'retry_later') {
      state.final = true
    }
    return outcome
  }

  return {
    /** A request or subscription to this environment was refused with this code/message. */
    noteRejected(environmentId: string, code: string | undefined, message: string): void {
      if (!isPairingRejection(code, message) || running.has(environmentId)) {
        return
      }
      const attempt = recover(environmentId)
        .catch((): CloudPairingRecoveryOutcome => 'failed')
        .finally(() => running.delete(environmentId))
      running.set(environmentId, attempt)
    },
    /** Tests: the attempt in flight for an environment. */
    pending(environmentId: string): Promise<CloudPairingRecoveryOutcome> | undefined {
      return running.get(environmentId)
    },
    recover
  }
}

export type CloudPairingRecovery = ReturnType<typeof createCloudPairingRecovery>
