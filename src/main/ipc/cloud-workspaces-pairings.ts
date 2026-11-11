// This device's pairings with cloud workspaces it does not own (the "<name> (cloud)" servers made
// by Open), the file that binds them to their sandboxes, and the prune that drops a pairing once its
// sandbox is gone (LC-1). Split from cloud-workspaces.ts, which registers the IPC handlers.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import type { CloudWorkspacesService } from '../cloud-workspaces/cloud-workspaces-service'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
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
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { HOSTED_SANDBOX_DRIVER_ID } from '../hosted-sandbox/hosted-sandbox-driver'
import { retireGoneCloudSandbox } from '../hosted-sandbox/cloud-sandbox-gone-retire'

const Id = z.string().regex(/^sbx_[0-9a-f]{24}$/)
const GrantId = z.string().regex(/^grt_[0-9a-f]{24}$/)

type GetService = () => Promise<CloudWorkspacesService | null>

export type CloudWorkspacesPairings = {
  prune: CloudPairingPrune
  readBindings: () => Promise<Record<string, Binding>>
  updateBindings: (
    change: (current: Record<string, Binding>) => Record<string, Binding>
  ) => Promise<void>
  /** The sandbox was deleted from here: its pairing and this desktop's own record go now (LC-2). */
  settleDeleted: (sandboxId: string) => Promise<void>
}

const RETIRED_STATUSES = new Set(['cleaned', 'cleanup_pending'])

/**
 * This desktop's own record of a sandbox deleted from Home or the API: retired the way the
 * sidebar's Delete retires it, so its row never lingers as "Orca Cloud · Couldn't start" (LC-2).
 */
async function retireOwnedRecords(
  sandboxId: string,
  removedServerStore: RemovedServerStore | undefined
): Promise<void> {
  const userDataPath = app.getPath('userData')
  for (const runtime of listEphemeralVmRuntimes(userDataPath)) {
    if (runtime.recipe?.provider !== 'orca-cloud' || RETIRED_STATUSES.has(runtime.status)) {
      continue
    }
    const handle = runtime.recipeResult
      ? environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
      : null
    if (handle?.driverState.sandboxId === sandboxId || handle?.environmentId === sandboxId) {
      await retireGoneCloudSandbox(userDataPath, removedServerStore, runtime)
      console.log(
        `[orca-cloud] pruned stale cloud workspace ${sandboxId} (${runtime.workspaceName ?? runtime.id}; deleted from here)`
      )
    }
  }
}

const bindingsFile = () => join(app.getPath('userData'), 'cloud-workspaces-environments.json')

type Binding = { environmentId: string; grantId: string | null; accountId?: string | null }

export const CloudEnvironmentId = z.string().min(1).max(256)
// Older builds stored the bare environment id; read it as a binding with an unknown grant.
const StoredBinding = z.union([
  CloudEnvironmentId.transform((environmentId): Binding => ({ environmentId, grantId: null })),
  z.object({
    environmentId: CloudEnvironmentId,
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

let pairings: CloudWorkspacesPairings | null = null
export const STARTUP_PRUNE_DELAY_MS = 15_000

/** One fetch of a sandbox: not found (deleted, or never visible) or destroyed means gone. */
async function sandboxPresence(getService: GetService, id: string): Promise<CloudSandboxPresence> {
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
export function createCloudWorkspacesPairings(
  getService: GetService,
  removedServerStore: RemovedServerStore | undefined
): CloudWorkspacesPairings {
  if (pairings) {
    return pairings
  }
  const prune = createCloudPairingPrune({
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
    presence: (id) => sandboxPresence(getService, id),
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
  const settleDeleted = async (sandboxId: string): Promise<void> => {
    await prune.forget(sandboxId).catch(() => undefined)
    await retireOwnedRecords(sandboxId, removedServerStore).catch((error: unknown) =>
      console.warn('[cloud-workspaces] could not retire a deleted sandbox record', error)
    )
  }
  pairings = { prune, readBindings, updateBindings, settleDeleted }
  return pairings
}
