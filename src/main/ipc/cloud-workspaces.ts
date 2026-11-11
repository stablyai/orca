// IPC for team cloud workspaces. Every handler answers `not_configured` when this build has no
// Orca Cloud control plane, so the renderer can hide the section instead of erroring.
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
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
import type { CloudReadSnapshotState } from '../../shared/cloud-workspaces/read-snapshot-state'
import { orcaCloudAccountId } from '../../shared/hosted-sandbox/orca-cloud-account'
import {
  listEnvironments,
  removeEnvironment
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  createCloudPairingPrune,
  type CloudPairingPrune,
  type CloudSandboxPresence
} from '../cloud-workspaces/cloud-pairing-prune'
import {
  retireRemovedRuntimeEnvironment,
  type RemovedServerStore
} from './runtime-environments/runtime-environment-removal-cleanup'
import { invalidateRuntimeEnvironmentTransport } from './runtime-environments/runtime-environments'
import { publishRuntimeEnvironmentCatalogChanged } from './runtime-environments/runtime-environment-catalog-broadcast'

const Id = z.string().regex(/^sbx_[0-9a-f]{24}$/)
const GrantId = z.string().regex(/^grt_[0-9a-f]{24}$/)
const ChatId = z.string().min(1).max(256)
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

const bindingsFile = () => join(app.getPath('userData'), 'cloud-workspaces-environments.json')

type Binding = { environmentId: string; grantId: string | null; accountId?: string | null }

const EnvironmentId = z.string().min(1).max(256)
// Older builds stored the bare environment id; read it as a binding with an unknown grant.
const StoredBinding = z.union([
  EnvironmentId.transform((environmentId): Binding => ({ environmentId, grantId: null })),
  z.object({
    environmentId: EnvironmentId,
    grantId: GrantId.nullable(),
    accountId: z.string().min(1).max(256).nullable().optional()
  })
])

async function readBindings(): Promise<Record<string, Binding>> {
  try {
    const parsed = z
      .record(Id, StoredBinding)
      .safeParse(JSON.parse(await readFile(bindingsFile(), 'utf8')))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

// Read-modify-write updates run one at a time so two quick pairings cannot drop each other.
let bindingsWrite: Promise<void> = Promise.resolve()

/** Temp file + rename so a crash mid-write never leaves a truncated bindings file. */
function updateBindings(
  change: (current: Record<string, Binding>) => Record<string, Binding>
): Promise<void> {
  bindingsWrite = bindingsWrite
    .catch(() => undefined)
    .then(async () => {
      const file = bindingsFile()
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(change(await readBindings())), { mode: 0o600 })
      await rename(temp, file)
    })
  return bindingsWrite
}

let pairingPrune: CloudPairingPrune | null = null
const STARTUP_PRUNE_DELAY_MS = 15_000

/** One fetch of a sandbox: not found (deleted, or never visible) or destroyed means gone. */
async function sandboxPresence(id: string): Promise<CloudSandboxPresence> {
  const s = await getService().catch(() => null)
  const result = await s?.get(id)
  if (!result) {
    return 'unknown'
  }
  if (result.ok) {
    return result.value.status === 'destroyed' ? 'gone' : 'present'
  }
  return result.status === 404 && result.error === 'not_found' ? 'gone' : 'unknown'
}

/** The pairing prune for this process; servers it drops are retired like a Settings removal. */
function getPairingPrune(removedServerStore: RemovedServerStore | undefined): CloudPairingPrune {
  if (pairingPrune) {
    return pairingPrune
  }
  pairingPrune = createCloudPairingPrune({
    activeAccountId: () =>
      orcaCloudAccountId(ensureActiveOrcaProfile(app.getPath('userData')).profile.cloud),
    readBindings,
    updateBindings,
    listVisible: async () => {
      const s = await getService().catch(() => null)
      // Everything this user can see in the team, archived and routine runs included.
      const result = await s?.list({ scope: 'team', archived: 'include', routines: 'include' })
      return result?.ok ? new Set(result.value.map((w) => w.id)) : null
    },
    presence: sandboxPresence,
    removeEnvironment: async (environmentId) => {
      const userDataPath = app.getPath('userData')
      if (!listEnvironments(userDataPath).some((e) => e.id === environmentId)) {
        return
      }
      removeEnvironment(userDataPath, environmentId)
      if (removedServerStore) {
        await retireRemovedRuntimeEnvironment(
          environmentId,
          invalidateRuntimeEnvironmentTransport,
          removedServerStore,
          userDataPath
        )
      }
      // The window re-reads its servers and purges the dropped host's projects and setups.
      publishRuntimeEnvironmentCatalogChanged()
    },
    log: (line) => console.warn(line)
  })
  return pairingPrune
}

let quitHookInstalled = false

const NOT_CONFIGURED = { ok: false as const, error: 'not_configured' }
const INVALID = { ok: false as const, error: 'invalid_request' }

export function registerCloudWorkspacesHandlers(
  options: { removedServerStore?: RemovedServerStore } = {}
): void {
  const prune = getPairingPrune(options.removedServerStore)
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
      .object({ workspaceId: Id, chatId: ChatId.nullable().optional() })
      .safeParse(args)
    const s = await getService()
    return !s
      ? NOT_CONFIGURED
      : parsed.success
        ? s.resolveLink(parsed.data.workspaceId, parsed.data.chatId)
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
