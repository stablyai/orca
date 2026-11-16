// Cloud workspaces in the desktop: the org registry, opening a workspace this device didn't create
// through a per-device E2EE grant, and keeping an opened (paired) workspace awake.
import { hostname } from 'node:os'
import { listEphemeralVmRuntimes } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtime-store'
import { openSealedGrant } from '../../shared/cloud-workspaces/sealed-grant'
import { errorMessage } from '../../shared/errors/error-message'
import type {
  CloudWorkspaceLinkTarget,
  CloudWorkspace,
  CloudWorkspaceListQuery,
  CloudWorkspacePatch,
  CloudWorkspacePrefsDocument,
  CloudWorkspaceRoutineRuns,
  OrgPrompts
} from '../../shared/cloud-workspaces/cloud-workspaces-wire'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { HOSTED_SANDBOX_DRIVER_ID } from '../hosted-sandbox/hosted-sandbox-driver'
import type { HostedSandboxConfig } from '../hosted-sandbox/hosted-sandbox-config'
import {
  createCloudWorkspacesClient,
  CloudWorkspacesError,
  type CloudWorkspacesClient
} from './cloud-workspaces-client'
import { generateGrantRecipientKey, nodeSealedGrantPrimitives } from './sealed-grant-node'
import {
  createReadSnapshotReader,
  type ReaderKeyAccess,
  type ReadPinAccess
} from './cloud-read-snapshot-reader'

/** How often a paired workspace in front checks whether its lease is due. */
const LEASE_CHECK_MS = 20_000
/** Renew a paired workspace's lease well before the control plane's 30 min lease lapses. */
const LEASE_BEAT_MS = 10 * 60_000
const LEASE_EXTEND_MS = 30 * 60_000
/** An opened grant's signer waits this long for its pairing to complete before it is dropped. */
const PAIRING_REPIN_TTL_MS = 15 * 60_000
const MAX_PENDING_REPINS = 16

export type CloudWorkspacesResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; reason?: string; status?: number; orgId?: string }

/** A list read, plus what Home's Routine runs switch hides (absent from older control planes). */
export type CloudWorkspaceListResult =
  | { ok: true; value: CloudWorkspace[]; routineRuns?: CloudWorkspaceRoutineRuns }
  | { ok: false; error: string; reason?: string; status?: number }

/** Where this desktop already has a cloud workspace locally (owner: the hosted runtime it created). */
export type LocalCloudWorkspace = {
  sandboxId: string
  worktreeId: string | null
  runtimeEnvironmentId: string | null
}

async function wrap<T>(run: () => Promise<T>): Promise<CloudWorkspacesResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    if (error instanceof CloudWorkspacesError) {
      return {
        ok: false,
        error: error.code,
        reason: error.reason,
        status: error.status,
        ...(error.orgId ? { orgId: error.orgId } : {})
      }
    }
    return { ok: false, error: 'internal_error', reason: errorMessage(error).slice(0, 200) }
  }
}

export function createCloudWorkspacesService(deps: {
  userDataPath: string
  config: HostedSandboxConfig
  clientId: string
  fetch?: typeof fetch
  /** This profile's reader key (sleeping-workspace snapshots); absent: reading them is off. */
  readerKey?: ReaderKeyAccess
  /** Per-workspace signer and rollback pins (persisted per profile); in memory when absent. */
  readPins?: ReadPinAccess
}) {
  const client: CloudWorkspacesClient = createCloudWorkspacesClient({
    baseUrl: deps.config.controlPlaneUrl,
    getAccessToken: deps.config.getAccessToken,
    fetch: deps.fetch ?? deps.config.fetch
  })
  let active: { sandboxId: string; leased: boolean } | null = null
  // One heartbeat per active workspace, renewing the lease when it is due. It stops as soon as the
  // renderer reports nothing in front (also when the window is hidden or idle).
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let leaseSandboxId: string | null = null
  let leaseRenewedAt = 0
  const reader = deps.readerKey
    ? createReadSnapshotReader({ client, readerKey: deps.readerKey, pins: deps.readPins })
    : null
  // Grants whose pairing has not completed yet, by pairing code: their signer may re-pin only once
  // main verifies that pairing (confirmPairing). Bounded and short-lived.
  const pendingRepins = new Map<
    string,
    { sandboxId: string; signer: string; identity: string; at: number }
  >()
  function rememberPendingRepin(
    pairingCode: string,
    entry: { sandboxId: string; signer: string; identity: string }
  ): void {
    pendingRepins.delete(pairingCode)
    pendingRepins.set(pairingCode, { ...entry, at: Date.now() })
    while (pendingRepins.size > MAX_PENDING_REPINS) {
      const oldest = pendingRepins.keys().next()
      if (oldest.done) {
        break
      }
      pendingRepins.delete(oldest.value)
    }
  }
  // Register the key up front: a workspace seals its snapshot to the keys known when it sleeps.
  void reader?.register()

  function localWorkspaces(): LocalCloudWorkspace[] {
    const out: LocalCloudWorkspace[] = []
    for (const runtime of listEphemeralVmRuntimes(deps.userDataPath)) {
      if (runtime.recipe?.provider !== 'orca-cloud' || !runtime.recipeResult) {
        continue
      }
      const handle = environmentHandleFromRecipeResult(
        runtime.recipeResult,
        HOSTED_SANDBOX_DRIVER_ID
      )
      if (handle) {
        out.push({
          sandboxId: handle.environmentId,
          worktreeId: runtime.workspaceId ?? null,
          runtimeEnvironmentId: runtime.runtimeEnvironmentId ?? null
        })
      }
    }
    return out
  }

  /** The owner's own lease scheduler keeps their VM up; a paired desktop renews while open. */
  function renewLeaseIfDue(): void {
    const current = active
    if (!current?.leased) {
      return
    }
    if (current.sandboxId === leaseSandboxId && Date.now() - leaseRenewedAt < LEASE_BEAT_MS) {
      return
    }
    leaseSandboxId = current.sandboxId
    leaseRenewedAt = Date.now()
    void client.renewLease(current.sandboxId, LEASE_EXTEND_MS).catch(() => undefined)
  }

  function stopTimers(): void {
    if (heartbeat) {
      clearInterval(heartbeat)
    }
    heartbeat = null
    leaseSandboxId = null
  }

  return {
    available: true as const,
    list: async (query: CloudWorkspaceListQuery): Promise<CloudWorkspaceListResult> => {
      let routineRuns: CloudWorkspaceRoutineRuns | undefined
      const result = await wrap(async () => {
        const page = await client.list(query)
        routineRuns = page.routineRuns
        // Cheap when already registered; catches a sign-in or account switch since the last list.
        void reader?.register()
        return page.workspaces
      })
      return result.ok && routineRuns ? { ...result, routineRuns } : result
    },
    /** Sign-out: revoke this device's reader key server-side (callers bound the wait). */
    revokeReaderKey: (timeoutMs: number) => reader?.revoke(timeoutMs) ?? Promise.resolve(),
    /**
     * Main's runtime-environment pairing verified this pairing code end to end (E2EE handshake with
     * the workspace's orcad). If an opened grant carried that code and a signer, re-pin it now. A
     * grant that was opened but never paired changes nothing beyond filling an empty pin.
     */
    async confirmPairing(pairingCode: string): Promise<void> {
      const entry = pendingRepins.get(pairingCode)
      pendingRepins.delete(pairingCode)
      if (!entry || !reader || Date.now() - entry.at > PAIRING_REPIN_TTL_MS) {
        return
      }
      await reader.repinAfterPairing(entry.identity, entry.sandboxId, entry.signer)
    },
    /** A sleeping workspace's sealed snapshot, opened on this device; never wakes it. */
    readSnapshot: (id: string) =>
      wrap(async () => {
        if (!reader) {
          throw new CloudWorkspacesError(0, 'not_configured')
        }
        return reader.read(id)
      }),
    get: (id: string) => wrap(() => client.get(id)),
    patch: (id: string, patch: CloudWorkspacePatch) =>
      wrap(async () => (await client.patch(id, patch)).workspace),
    resolveLink: (target: CloudWorkspaceLinkTarget, chatId?: string | null) =>
      wrap(() => client.resolveLink(target, chatId)),
    getPrefs: () => wrap(() => client.getPrefs()),
    putPrefs: (document: CloudWorkspacePrefsDocument, revision: number) =>
      wrap(() => client.putPrefs(document, revision, deps.clientId)),
    listGrants: (id: string) => wrap(() => client.listGrants(id)),
    revokeGrant: (id: string, grantId: string) =>
      wrap(async () => void (await client.revokeGrant(id, grantId))),
    getOrgPrompts: () => wrap(() => client.getOrgPrompts()),
    putOrgPrompts: (document: OrgPrompts['document'], revision: number) =>
      wrap(() => client.putOrgPrompts(document, revision)),
    changeOwner: (id: string, ownerUserId: string) =>
      wrap(() => client.changeOwner(id, ownerUserId)),
    ownerNotices: () => wrap(() => client.ownerNotices()),
    dismissOwnerNotice: (id: string) => wrap(() => client.dismissOwnerNotice(id)),
    localWorkspaces: () => localWorkspaces(),
    sleep: (id: string) => wrap(() => client.sleep(id)),
    /** PAIRED-WAKE: wake a workspace this desktop paired with (no local VM record to resume). */
    wake: (id: string) => wrap(async () => void (await client.wake(id))),
    destroy: (id: string) => wrap(() => client.destroy(id)),

    /**
     * A per-device credential for a workspace this desktop does not own: a fresh X25519 key lives
     * only for this call; the VM seals a single-device orcad offer to it. The pairing link is handed
     * to the normal add-server path (ticket exchange replaces its token with one minted here).
     */
    openGrant: (id: string) =>
      wrap(async () => {
        const key = generateGrantRecipientKey()
        try {
          const issued = await client.issueGrant(id, {
            recipientPublicKeyB64: key.publicKeyB64,
            deviceLabel: hostname().slice(0, 80) || 'Desktop',
            deviceKind: 'desktop'
          })
          try {
            const opened = await openSealedGrant(
              issued.sealed,
              issued.grant.id,
              key.secretKey,
              nodeSealedGrantPrimitives,
              // A desktop pairs as a runtime client; a mobile-scoped offer is useless here.
              'runtime'
            )
            // Pairing names the workspace's snapshot signer: the trusted (re-)pin, e.g. after the
            // VM's disk was replaced. Best effort; the pairing itself must not fail on it.
            const signer = opened.readSignerPublicKeyB64
            const identity = deps.readerKey?.identity() ?? null
            if (signer && reader && identity) {
              await reader.pinSigner(id, signer).catch(() => undefined)
              rememberPendingRepin(opened.pairingUrl, { sandboxId: id, signer, identity })
            }
            return { grantId: issued.grant.id, pairingCode: opened.pairingUrl }
          } catch (error) {
            // Nothing can use a grant we failed to open; revoke it so it does not count as a device.
            await client.revokeGrant(id, issued.grant.id).catch(() => undefined)
            throw error
          }
        } finally {
          key.secretKey.fill(0)
        }
      }),

    /** The renderer reports which cloud workspace is in front (null when none). */
    setActive(args: { sandboxId: string | null; leased?: boolean }): void {
      if (!args.sandboxId) {
        active = null
        stopTimers()
        return
      }
      active = { sandboxId: args.sandboxId, leased: args.leased ?? active?.leased ?? false }
      renewLeaseIfDue()
      if (!heartbeat) {
        heartbeat = setInterval(renewLeaseIfDue, LEASE_CHECK_MS)
        heartbeat.unref?.()
      }
    },
    dispose(): void {
      this.setActive({ sandboxId: null })
    }
  }
}

export type CloudWorkspacesService = ReturnType<typeof createCloudWorkspacesService>
