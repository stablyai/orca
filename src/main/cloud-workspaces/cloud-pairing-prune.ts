// Drops this device's pairing with a cloud workspace whose sandbox no longer exists (LC-1). Opening
// a workspace this desktop does not own pairs it as a "<name> (cloud)" server, and that server's
// projects mirror into the sidebar. Once the sandbox was deleted (from Home, another desktop, the
// control plane), the server, its struck-out host row and its projects stayed forever.
//
// Only an authoritative answer drops one: missing from the active team's successful list, then
// confirmed by one more fetch of that sandbox answering not found or destroyed. A failed list, a
// failed or ambiguous confirm, or a team switch mid-check keeps everything, so a network blip never
// wipes a pairing. (Owned workspaces are retired by cloud-sandbox-gone-prune; this is the pairing
// half.)

export type CloudPairingBinding = {
  environmentId: string
  grantId: string | null
  /** The team the sandbox belongs to; absent on bindings saved before LC-1. */
  accountId?: string | null
}

export type CloudPairingBindings = Record<string, CloudPairingBinding>

/** What one fetch of a sandbox said: only `gone` (not found, or destroyed) lets a pairing go. */
export type CloudSandboxPresence = 'gone' | 'present' | 'unknown'

export type CloudPairingPrune = {
  /** Startup and each cloud list refresh. Single-flight; list-triggered runs are throttled. */
  run(options?: { force?: boolean }): Promise<void>
  /** The sandbox was deleted from here: drop its pairing now, no fetch needed. */
  forget(sandboxId: string): Promise<void>
  /** A pairing was just saved: stamp it with the active team. */
  accountForNewBinding(): string | null
}

export function createCloudPairingPrune(deps: {
  activeAccountId: () => string | null
  readBindings: () => Promise<CloudPairingBindings>
  updateBindings: (change: (current: CloudPairingBindings) => CloudPairingBindings) => Promise<void>
  /** Ids of every sandbox the active team's list shows this user; null when the list failed. */
  listVisible: () => Promise<ReadonlySet<string> | null>
  /** One fetch of a single sandbox. */
  presence: (sandboxId: string) => Promise<CloudSandboxPresence>
  /** Remove the paired server; the window's catalog refresh then purges its projects. */
  removeEnvironment: (environmentId: string) => Promise<void>
  minIntervalMs?: number
  now?: () => number
  log?: (line: string) => void
}): CloudPairingPrune {
  const now = deps.now ?? Date.now
  const minIntervalMs = deps.minIntervalMs ?? 60_000
  let lastRunAt = Number.NEGATIVE_INFINITY
  let running: Promise<void> | null = null

  async function forget(sandboxId: string): Promise<void> {
    let dropped: CloudPairingBinding | undefined
    let stillUsed = false
    await deps.updateBindings((current) => {
      dropped = current[sandboxId]
      if (!dropped) {
        return current
      }
      const next = { ...current }
      delete next[sandboxId]
      stillUsed = Object.values(next).some((b) => b.environmentId === dropped?.environmentId)
      return next
    })
    if (dropped && !stillUsed) {
      await deps.removeEnvironment(dropped.environmentId)
    }
  }

  async function prune(): Promise<void> {
    const account = deps.activeAccountId()
    if (!account) {
      return
    }
    const bindings = await deps.readBindings()
    // Another team's pairing is not this list's to judge. Unstamped ones are judged by the confirm.
    const candidates = Object.entries(bindings).filter(
      ([, binding]) => !binding.accountId || binding.accountId === account
    )
    if (candidates.length === 0) {
      return
    }
    const listed = await deps.listVisible()
    if (!listed || deps.activeAccountId() !== account) {
      return
    }
    // Listed means it is this team's: stamp older bindings so later team switches leave them be.
    const unstampedListed = candidates.filter(([id, b]) => !b.accountId && listed.has(id))
    if (unstampedListed.length > 0) {
      await deps.updateBindings((current) => {
        const next = { ...current }
        for (const [id] of unstampedListed) {
          if (next[id] && !next[id].accountId) {
            next[id] = { ...next[id], accountId: account }
          }
        }
        return next
      })
    }
    for (const [sandboxId] of candidates) {
      if (listed.has(sandboxId)) {
        continue
      }
      const presence = await deps.presence(sandboxId)
      // The confirming answer must still be for the team the list was for.
      if (presence !== 'gone' || deps.activeAccountId() !== account) {
        continue
      }
      try {
        await forget(sandboxId)
        deps.log?.(`[cloud-workspaces] dropped the pairing with ${sandboxId}: sandbox is gone`)
      } catch (error) {
        deps.log?.(`[cloud-workspaces] could not drop a gone sandbox's pairing: ${String(error)}`)
      }
    }
  }

  return {
    run(options) {
      if (running) {
        return running
      }
      if (!options?.force && now() - lastRunAt < minIntervalMs) {
        return Promise.resolve()
      }
      lastRunAt = now()
      running = prune()
        .catch((error) => deps.log?.(`[cloud-workspaces] pairing prune failed: ${String(error)}`))
        .finally(() => {
          running = null
        })
      return running
    },
    forget,
    accountForNewBinding: () => deps.activeAccountId()
  }
}
