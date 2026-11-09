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

const Id = z.string().regex(/^sbx_[0-9a-f]{24}$/)
const GrantId = z.string().regex(/^grt_[0-9a-f]{24}$/)
const ChatId = z.string().min(1).max(256)
const ListQuery = z
  .object({
    scope: z.enum(['mine', 'team', 'all']).optional(),
    by: z.string().max(128).optional(),
    repo: z.string().max(2048).optional(),
    section: z.string().max(64).optional(),
    archived: z.enum(['exclude', 'include', 'only']).optional()
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
      clientId: await clientIdFor(userDataPath)
    })
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

type Binding = { environmentId: string; grantId: string | null }

const EnvironmentId = z.string().min(1).max(256)
// Older builds stored the bare environment id; read it as a binding with an unknown grant.
const StoredBinding = z.union([
  EnvironmentId.transform((environmentId): Binding => ({ environmentId, grantId: null })),
  z.object({ environmentId: EnvironmentId, grantId: GrantId.nullable() })
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

let quitHookInstalled = false

const NOT_CONFIGURED = { ok: false as const, error: 'not_configured' }
const INVALID = { ok: false as const, error: 'invalid_request' }

export function registerCloudWorkspacesHandlers(): void {
  const handle = (channel: string, fn: (args: unknown) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, args: unknown) => fn(args))
  }
  handle('cloudWorkspaces:available', async () => (await getService()) !== null)
  handle('cloudWorkspaces:list', async (args) => {
    const query = ListQuery.safeParse(args ?? {})
    const s = await getService()
    return !s ? NOT_CONFIGURED : query.success ? s.list(query.data) : INVALID
  })
  handle('cloudWorkspaces:get', async (args) => {
    const parsed = z.object({ id: Id }).safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : parsed.success ? s.get(parsed.data.id) : INVALID
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
      await updateBindings((current) => ({
        ...current,
        [sandboxId]: { environmentId: runtimeEnvironmentId, grantId: grantId ?? null }
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
  // Handlers are re-registered per main window; the quit hook must only be added once.
  if (!quitHookInstalled) {
    quitHookInstalled = true
    app.once('will-quit', () => service?.dispose())
  }
}
