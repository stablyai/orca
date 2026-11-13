// EP-8: a cloud workspace's server refuses this computer's saved pairing (an owner change revoked
// its device, or a teammate's grant was revoked). Retrying the old token forever ("Reconnecting…",
// "rejected the pairing token") never recovers, so ask Orca Cloud for a fresh grant for this
// computer and swap it in on the same server. The server's own access check decides: the current
// owner or a member who can still see the workspace gets one; anyone else is refused and told so.
// Strictly one attempt per server per saved pairing: a refused or failed attempt is never retried
// for that pairing, so a revoked device can't hammer the control plane.

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
  /** Swaps the pairing on the same environment (same host key only); true when saved. */
  repair: (environmentId: string, pairingCode: string) => Promise<boolean>
  bind: (sandboxId: string, environmentId: string, grantId: string) => Promise<void>
  revokeGrant: (sandboxId: string, grantId: string) => Promise<void>
  invalidate: (environmentId: string) => Promise<void> | void
  /** The account can no longer open it: tell the window (one clear action there). */
  onAccessLost: (environmentId: string, sandboxId: string) => void
}

export type CloudPairingRecoveryOutcome =
  | 'not_cloud'
  | 'already_tried'
  | 'repaired'
  | 'access_lost'
  | 'failed'

export function createCloudPairingRecovery(deps: CloudPairingRecoveryDeps) {
  const tried = new Set<string>()
  const running = new Map<string, Promise<CloudPairingRecoveryOutcome>>()

  async function recover(environmentId: string): Promise<CloudPairingRecoveryOutcome> {
    const revision = deps.revision(environmentId)
    if (revision === null) {
      return 'not_cloud'
    }
    const key = `${environmentId}:${revision}`
    if (tried.has(key)) {
      return 'already_tried'
    }
    tried.add(key)
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
      return 'failed'
    }
    // A repair that throws (the ticket exchange can fail on the network) counts as not saved.
    const saved = await deps.repair(environmentId, grant.value.pairingCode).catch(() => false)
    if (!saved) {
      // The fresh grant is unused here (a different server, or the swap failed): never leave it
      // behind as a stray device.
      await deps.revokeGrant(target.sandboxId, grant.value.grantId).catch(() => undefined)
      return 'failed'
    }
    if (target.kind === 'paired') {
      // The new pairing is saved either way: a failed bind must not keep the old grant alive.
      await deps.bind(target.sandboxId, environmentId, grant.value.grantId).catch(() => undefined)
      if (target.grantId && target.grantId !== grant.value.grantId) {
        await deps.revokeGrant(target.sandboxId, target.grantId).catch(() => undefined)
      }
    }
    await deps.invalidate(environmentId)
    return 'repaired'
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
