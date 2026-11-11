// IPC for team cloud workspaces. Every handler answers `not_configured` when this build has no
// Orca Cloud control plane, so the renderer can hide the section instead of erroring.
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { z } from 'zod'
import { withCloudBuildDefaults } from '../cloud-build-defaults'
import { getHostedSandboxConfig } from '../hosted-sandbox/hosted-sandbox-config'
import {
  createCloudWorkspacesService,
  type CloudWorkspacesService
} from '../cloud-workspaces/cloud-workspaces-service'
import {
  getCloudReaderKeyStore,
  setCloudReaderKeyRevoker
} from '../cloud-workspaces/cloud-reader-key-store'
import type { ReaderKeyAccess } from '../cloud-workspaces/cloud-read-snapshot-reader'
import { registerTeamPresenceHandlers } from './cloud-workspaces-team-presence'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { registerCloudWorkspacePrefsHandlers } from './cloud-workspaces-prefs'
import type { CloudReadSnapshotState } from '../../shared/cloud-workspaces/read-snapshot-state'
import type { RemovedServerStore } from './runtime-environments/runtime-environment-removal-cleanup'
import {
  CloudEnvironmentId as EnvironmentId,
  createCloudWorkspacesPairings,
  STARTUP_PRUNE_DELAY_MS
} from './cloud-workspaces-pairings'

const Id = z.string().regex(/^sbx_[0-9a-f]{24}$/)
const GrantId = z.string().regex(/^grt_[0-9a-f]{24}$/)
const ChatId = z.string().min(1).max(256)
const LinkTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('id'), workspaceId: Id }),
  z.object({
    kind: z.literal('number'),
    org: z.string().regex(/^[a-z0-9-]{1,40}$/),
    number: z.number().int().min(1).max(999_999_999)
  })
])
const ListQuery = z
  .object({
    scope: z.enum(['mine', 'team', 'all']).optional(),
    by: z.string().max(128).optional(),
    repo: z.string().max(2048).optional(),
    section: z.string().max(64).optional(),
    archived: z.enum(['exclude', 'include', 'only']).optional(),
    routines: z.enum(['exclude', 'include']).optional()
  })
  .strict()
const Patch = z
  .object({
    title: z.string().max(120).nullable().optional(),
    branch: z.string().max(255).nullable().optional(),
    visibility: z.enum(['private', 'team']).optional(),
    section: z.string().max(64).nullable().optional(),
    archived: z.boolean().optional(),
    ownerUserId: z.string().max(128).optional(),
    tokenUsdMicros: z.number().int().min(0).optional()
  })
  .strict()
const Prompts = z.object({
  prompts: z.array(z.object({ id: z.string(), name: z.string(), body: z.string() })).max(50),
  prInstructions: z.string().max(8000)
})

let service: CloudWorkspacesService | null = null
let servicePromise: Promise<CloudWorkspacesService | null> | undefined

function getService(): Promise<CloudWorkspacesService | null> {
  if (servicePromise) {
    return servicePromise
  }
  const starting = (async () => {
    const userDataPath = app.getPath('userData')
    const config = getHostedSandboxConfig(
      userDataPath,
      withCloudBuildDefaults(process.env),
      app.isPackaged
    )
    if (!config) {
      return null
    }
    service = createCloudWorkspacesService({
      userDataPath,
      config,
      clientId: await clientIdFor(userDataPath),
      readerKey: profileReaderKey(userDataPath)
    })
    const started = service
    setCloudReaderKeyRevoker((timeoutMs) => started.revokeReaderKey(timeoutMs))
    return service
  })()
  servicePromise = starting
  // A failed start (e.g. unreadable user data) must not stick; the next call tries again.
  starting.catch(() => {
    if (servicePromise === starting) {
      servicePromise = undefined
    }
  })
  return starting
}

/** The active Orca profile's reader key; registrations follow its signed-in user and account. */
function profileReaderKey(userDataPath: string): ReaderKeyAccess {
  return {
    identity: () => {
      const active = ensureActiveOrcaProfile(userDataPath)
      const cloud = active.profile.cloud
      return cloud
        ? JSON.stringify([active.profile.id, cloud.userId ?? null, cloud.activeOrgId ?? null])
        : null
    },
    load: () =>
      getCloudReaderKeyStore(userDataPath).load(ensureActiveOrcaProfile(userDataPath).profile.id),
    peek: () =>
      getCloudReaderKeyStore(userDataPath).peek(ensureActiveOrcaProfile(userDataPath).profile.id)
  }
}

/**
 * The owner's asleep view merges this in (main process). Null when it cannot be read (no control
 * plane, keychain, network); the view then keeps showing this computer's own copy.
 */
export async function readCloudWorkspaceSnapshot(
  sandboxId: string
): Promise<CloudReadSnapshotState | null> {
  if (!Id.safeParse(sandboxId).success) {
    return null
  }
  const s = await getService().catch(() => null)
  const result = await s?.readSnapshot(sandboxId)
  return result?.ok ? result.value : null
}

/** Stable per-install id for presence rows (one row per device, not per window). */
async function clientIdFor(userDataPath: string): Promise<string> {
  const file = join(userDataPath, 'cloud-workspaces-client-id')
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (/^[A-Za-z0-9_.:-]{8,128}$/.test(existing)) {
      return existing
    }
  } catch {
    // First run.
  }
  const id = `desktop-${randomUUID()}`
  try {
    await writeFile(file, id, { mode: 0o600 })
  } catch {
    // Presence still works for this session.
  }
  return id
}

let quitHookInstalled = false

const NOT_CONFIGURED = { ok: false as const, error: 'not_configured' }
const INVALID = { ok: false as const, error: 'invalid_request' }

export function registerCloudWorkspacesHandlers(
  options: { removedServerStore?: RemovedServerStore } = {}
): void {
  const { prune, readBindings, updateBindings } = createCloudWorkspacesPairings(
    getService,
    options.removedServerStore
  )
  const handle = (channel: string, fn: (args: unknown) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, args: unknown) => fn(args))
  }
  handle('cloudWorkspaces:available', async () => (await getService()) !== null)
  handle('cloudWorkspaces:list', async (args) => {
    const query = ListQuery.safeParse(args ?? {})
    const s = await getService()
    if (!s) {
      return NOT_CONFIGURED
    }
    if (!query.success) {
      return INVALID
    }
    const result = await s.list(query.data)
    // Each successful refresh also checks this device's pairings (throttled, in the background).
    if (result.ok) {
      void prune.run()
    }
    return result
  })
  handle('cloudWorkspaces:get', async (args) => {
    const parsed = z.object({ id: Id }).safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : parsed.success ? s.get(parsed.data.id) : INVALID
  })
  handle('cloudWorkspaces:noteSent', async (args) => {
    const parsed = z.object({ id: Id }).safeParse(args)
    const s = await getService()
    if (s && parsed.success) {
      await s.noteSent(parsed.data.id)
    }
  })
  handle('cloudWorkspaces:patch', async (args) => {
    const parsed = z.object({ id: Id, patch: Patch }).safeParse(args)
    const s = await getService()
    return !s
      ? NOT_CONFIGURED
      : parsed.success
        ? s.patch(parsed.data.id, parsed.data.patch)
        : INVALID
  })
  handle('cloudWorkspaces:resolveLink', async (args) => {
    const parsed = z
      .object({ target: LinkTarget, chatId: ChatId.nullable().optional() })
      .safeParse(args)
    const s = await getService()
    return !s
      ? NOT_CONFIGURED
      : parsed.success
        ? s.resolveLink(parsed.data.target, parsed.data.chatId)
        : INVALID
  })
  handle('cloudWorkspaces:openGrant', async (args) => {
    const parsed = z.object({ id: Id }).safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : parsed.success ? s.openGrant(parsed.data.id) : INVALID
  })
  handle('cloudWorkspaces:readSnapshot', async (args) => {
    const parsed = z.object({ id: Id }).safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : parsed.success ? s.readSnapshot(parsed.data.id) : INVALID
  })
  handle('cloudWorkspaces:listGrants', async (args) => {
    const parsed = z.object({ id: Id }).safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : parsed.success ? s.listGrants(parsed.data.id) : INVALID
  })
  handle('cloudWorkspaces:revokeGrant', async (args) => {
    const parsed = z.object({ id: Id, grantId: GrantId }).safeParse(args)
    const s = await getService()
    return !s
      ? NOT_CONFIGURED
      : parsed.success
        ? s.revokeGrant(parsed.data.id, parsed.data.grantId)
        : INVALID
  })
  handle('cloudWorkspaces:sleep', async (args) => {
    const parsed = z.object({ id: Id }).safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : parsed.success ? s.sleep(parsed.data.id) : INVALID
  })
  handle('cloudWorkspaces:destroy', async (args) => {
    const parsed = z.object({ id: Id }).safeParse(args)
    const s = await getService()
    if (!s) {
      return NOT_CONFIGURED
    }
    if (!parsed.success) {
      return INVALID
    }
    const result = await s.destroy(parsed.data.id)
    // Deleted from here: its pairing, server and projects go now, not at the next list.
    if (result.ok) {
      await prune.forget(parsed.data.id).catch(() => undefined)
    }
    return result
  })
  handle(
    'cloudWorkspaces:localWorkspaces',
    async () => (await getService())?.localWorkspaces() ?? []
  )
  handle('cloudWorkspaces:environmentBindings', () => readBindings())
  handle('cloudWorkspaces:bindEnvironment', async (args) => {
    const parsed = z
      .object({
        sandboxId: Id,
        runtimeEnvironmentId: EnvironmentId,
        grantId: GrantId.nullable().optional()
      })
      .safeParse(args)
    if (parsed.success) {
      const { sandboxId, runtimeEnvironmentId, grantId } = parsed.data
      const accountId = prune.accountForNewBinding()
      await updateBindings((current) => ({
        ...current,
        [sandboxId]: { environmentId: runtimeEnvironmentId, grantId: grantId ?? null, accountId }
      }))
    }
  })
  handle('cloudWorkspaces:setActive', async (args) => {
    const parsed = z
      .object({
        sandboxId: Id.nullable(),
        chatId: ChatId.nullable().optional(),
        typing: z.boolean().optional(),
        leased: z.boolean().optional()
      })
      .safeParse(args)
    const s = await getService()
    if (parsed.success) {
      s?.setActive(parsed.data)
    }
  })
  handle(
    'cloudWorkspaces:getOrgPrompts',
    async () => (await getService())?.getOrgPrompts() ?? NOT_CONFIGURED
  )
  handle('cloudWorkspaces:putOrgPrompts', async (args) => {
    const parsed = z
      .object({ document: Prompts, revision: z.number().int().min(0) })
      .safeParse(args)
    const s = await getService()
    return !s
      ? NOT_CONFIGURED
      : parsed.success
        ? s.putOrgPrompts(parsed.data.document, parsed.data.revision)
        : INVALID
  })
  registerCloudWorkspacePrefsHandlers(handle, getService)
  registerTeamPresenceHandlers(handle, getService)
  // Handlers are re-registered per main window; the quit hook must only be added once.
  if (!quitHookInstalled) {
    quitHookInstalled = true
    // Startup: pairings whose sandbox was deleted while this app was closed go now. Delayed so
    // the Orca session is restored first; a list that still fails just leaves everything alone.
    setTimeout(() => void prune.run({ force: true }), STARTUP_PRUNE_DELAY_MS).unref?.()
    app.once('will-quit', () => service?.dispose())
  }
}
