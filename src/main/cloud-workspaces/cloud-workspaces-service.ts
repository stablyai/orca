// Team cloud workspaces in the desktop: the org registry, opening a teammate's workspace through a
// per-device E2EE grant, live presence and keeping an opened workspace awake.
import { hostname } from 'node:os'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { openSealedGrant } from '../../shared/cloud-workspaces/sealed-grant'
import { errorMessage } from '../../shared/error-message'
import type {
  CloudWorkspaceListQuery,
  CloudWorkspacePatch,
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

const PRESENCE_BEAT_MS = 20_000
/** Renew a teammate-opened workspace's lease well before the control plane's 30 min lease lapses. */
const LEASE_BEAT_MS = 10 * 60_000
const LEASE_EXTEND_MS = 30 * 60_000
const TYPING_HOLD_MS = 6_000

export type CloudWorkspacesResult<T> =
  | { ok: true; value: T }
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
      return { ok: false, error: error.code, reason: error.reason, status: error.status }
    }
    return { ok: false, error: 'internal_error', reason: errorMessage(error).slice(0, 200) }
  }
}

export function createCloudWorkspacesService(deps: {
  userDataPath: string
  config: HostedSandboxConfig
  clientId: string
  fetch?: typeof fetch
}) {
  const client: CloudWorkspacesClient = createCloudWorkspacesClient({
    baseUrl: deps.config.controlPlaneUrl,
    getAccessToken: deps.config.getAccessToken,
    fetch: deps.fetch
  })
  let active: {
    sandboxId: string
    chatId: string | null
    typingUntil: number
    leased: boolean
  } | null = null
  // One heartbeat per active workspace: presence every beat, the lease when it is due. It stops as
  // soon as the renderer reports nothing in front (also when the window is hidden or idle).
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let leaseSandboxId: string | null = null
  let leaseRenewedAt = 0

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

  async function beat(): Promise<void> {
    const current = active
    if (!current) {
      return
    }
    const state = Date.now() < current.typingUntil ? 'typing' : 'viewing'
    await client
      .presence(current.sandboxId, { clientId: deps.clientId, state, chatId: current.chatId })
      .catch(() => undefined)
  }

  /** The owner's own lease scheduler keeps their VM up; a teammate's desktop renews while open. */
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
    list: (query: CloudWorkspaceListQuery) => wrap(() => client.list(query)),
    get: (id: string) => wrap(() => client.get(id)),
    patch: (id: string, patch: CloudWorkspacePatch) =>
      wrap(async () => (await client.patch(id, patch)).workspace),
    resolveLink: (workspaceId: string, chatId?: string | null) =>
      wrap(() => client.resolveLink(workspaceId, chatId)),
    listGrants: (id: string) => wrap(() => client.listGrants(id)),
    revokeGrant: (id: string, grantId: string) =>
      wrap(async () => void (await client.revokeGrant(id, grantId))),
    getOrgPrompts: () => wrap(() => client.getOrgPrompts()),
    putOrgPrompts: (document: OrgPrompts['document'], revision: number) =>
      wrap(() => client.putOrgPrompts(document, revision)),
    localWorkspaces: () => localWorkspaces(),

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

    /** The renderer reports which cloud workspace is in front (null when none) and composer typing. */
    setActive(args: {
      sandboxId: string | null
      chatId?: string | null
      typing?: boolean
      leased?: boolean
    }): void {
      if (!args.sandboxId) {
        const previous = active
        active = null
        stopTimers()
        if (previous) {
          void client
            .presence(previous.sandboxId, { clientId: deps.clientId, state: 'left' })
            .catch(() => undefined)
        }
        return
      }
      const changed = active?.sandboxId !== args.sandboxId
      const previousChatId = active?.chatId ?? null
      if (changed && active) {
        void client
          .presence(active.sandboxId, { clientId: deps.clientId, state: 'left' })
          .catch(() => undefined)
      }
      active = {
        sandboxId: args.sandboxId,
        // undefined keeps the chat (typing beats); null means no chat is in front any more.
        chatId: args.chatId !== undefined ? args.chatId : changed ? null : (active?.chatId ?? null),
        typingUntil: args.typing
          ? Date.now() + TYPING_HOLD_MS
          : changed
            ? 0
            : (active?.typingUntil ?? 0),
        leased: args.leased ?? active?.leased ?? false
      }
      if (changed || args.typing || active.chatId !== previousChatId) {
        void beat()
      }
      renewLeaseIfDue()
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          void beat()
          renewLeaseIfDue()
        }, PRESENCE_BEAT_MS)
        heartbeat.unref?.()
      }
    },
    dispose(): void {
      this.setActive({ sandboxId: null })
    }
  }
}

export type CloudWorkspacesService = ReturnType<typeof createCloudWorkspacesService>
