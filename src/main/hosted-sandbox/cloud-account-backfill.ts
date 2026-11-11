// Files Orca Cloud runtime records under the team that owns them. The control plane lists only the
// caller's account's sandboxes, so a sandbox in the active team's list belongs to that team. This
// files records written before the team was recorded, and corrects one a create filed under the
// team a switch left behind. Records it can't place stay unfiled, and lists hide them.
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { HostedSandboxView } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'

const RETIRED = new Set<EphemeralVmRuntimeRecord['status']>(['cleaned', 'cleanup_pending'])

function sandboxIdOf(runtime: EphemeralVmRuntimeRecord): string | null {
  const handle = runtime.recipeResult
    ? environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
    : null
  const id = handle?.driverState.sandboxId
  return typeof id === 'string' && id ? id : null
}

export type CloudAccountBackfill = {
  /**
   * Lists the active team's sandboxes when a live record is unfiled, the team changed, or the last
   * list is older than `relistMs` (the first run, at startup, always lists).
   */
  run(): Promise<void>
}

export function createCloudAccountBackfill(deps: {
  userDataPath: string
  activeAccountId: () => string | null
  list: () => Promise<readonly Pick<HostedSandboxView, 'id'>[]>
  /** Each successful list, for the team it answered for (the gone-sandbox prune reads it). */
  onListed?: (account: string, listed: ReadonlySet<string>) => Promise<void>
  /** Re-list this often even when nothing changed, so a sandbox destroyed elsewhere is noticed. */
  relistMs?: number
  now?: () => number
  log?: (line: string) => void
}): CloudAccountBackfill {
  const now = deps.now ?? Date.now
  // One list per (team, unfiled set) or per relistMs: the 30 s beat must not list on every tick.
  let lastKey: string | null = null
  let listedAt = Number.NEGATIVE_INFINITY
  return {
    async run() {
      const account = deps.activeAccountId()
      if (!account) {
        return
      }
      const before = readCloud(deps.userDataPath)
      // A team switch re-lists once even with nothing unfiled: it corrects a misfiled create.
      const key = keyOf(account, before)
      const stale = deps.relistMs !== undefined && now() - listedAt >= deps.relistMs
      if (before.length === 0 || (key === lastKey && !stale)) {
        return
      }
      let listed: ReadonlySet<string>
      try {
        listed = new Set((await deps.list()).map((sandbox) => sandbox.id))
      } catch (error) {
        deps.log?.(`[orca-cloud] could not list sandboxes to file them by team: ${String(error)}`)
        return
      }
      // The list answered for whichever team the token was minted for; drop it if that moved.
      if (deps.activeAccountId() !== account) {
        return
      }
      for (const runtime of readCloud(deps.userDataPath)) {
        const sandboxId = sandboxIdOf(runtime)
        if (sandboxId && listed.has(sandboxId) && runtime.cloudAccountId !== account) {
          updateEphemeralVmRuntimeStatus(deps.userDataPath, runtime.id, {
            cloudAccountId: account,
            updatedAt: runtime.updatedAt
          })
        }
      }
      // Keyed on what is still unfiled, so this team does not list again until that changes.
      lastKey = keyOf(account, readCloud(deps.userDataPath))
      listedAt = now()
      await deps.onListed?.(account, listed)
    }
  }
}

/** Live Orca Cloud records with a sandbox to look for. */
function readCloud(userDataPath: string): EphemeralVmRuntimeRecord[] {
  return listEphemeralVmRuntimes(userDataPath).filter(
    (runtime) =>
      runtime.recipe?.provider === 'orca-cloud' &&
      !RETIRED.has(runtime.status) &&
      sandboxIdOf(runtime) !== null
  )
}

function keyOf(account: string, cloud: readonly EphemeralVmRuntimeRecord[]): string {
  const unfiled = cloud
    .filter((runtime) => !runtime.cloudAccountId)
    .map((runtime) => runtime.id)
    .sort()
  return JSON.stringify([account, unfiled])
}
