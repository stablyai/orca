// Retires Orca Cloud records whose sandbox no longer exists. A sandbox destroyed out of band (the
// team list's Delete on another desktop, the control plane) left its record, server and project
// here, and after a restart its clone came back as a stray folder project with a "Couldn't start"
// row. Only an authoritative answer retires one: missing from the active team's successful list,
// then confirmed by a second such list or by the sandbox itself answering not found or destroyed.
// Errors, a team switch mid-check, and asleep (suspended/archived, still listed) sandboxes never do.
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { HostedSandboxView } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { isEphemeralVmProvisionLive } from '../ephemeral-vm/runtime-provisioning-persistence'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'

const RETIRED = new Set<EphemeralVmRuntimeRecord['status']>(['cleaned', 'cleanup_pending'])

function sandboxIdOf(runtime: EphemeralVmRuntimeRecord): string | null {
  const handle = runtime.recipeResult
    ? environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
    : null
  const id = handle?.driverState.sandboxId
  return typeof id === 'string' && id ? id : null
}

export type CloudSandboxGonePrune = {
  /** After a successful list of `account`'s sandboxes: retire that team's records it confirms gone. */
  observeList(account: string, listed: ReadonlySet<string>): Promise<void>
}

export function createCloudSandboxGonePrune(deps: {
  userDataPath: string
  activeAccountId: () => string | null
  get: (sandboxId: string) => Promise<Pick<HostedSandboxView, 'status'>>
  /** The app's own teardown for a destroyed cloud workspace: record, server, project. */
  retire: (runtime: EphemeralVmRuntimeRecord) => Promise<void>
  log?: (line: string) => void
}): CloudSandboxGonePrune {
  // Sandboxes one list has missed; a second miss in a row confirms them.
  let missedOnce = new Set<string>()

  /** True only on a definite answer that the sandbox is gone; any error is "don't know". */
  async function confirmedGone(sandboxId: string): Promise<boolean> {
    try {
      return (await deps.get(sandboxId)).status === 'destroyed'
    } catch (error) {
      return isEnvironmentProviderError(error, 'not_found')
    }
  }

  return {
    async observeList(account, listed) {
      const missing = listEphemeralVmRuntimes(deps.userDataPath).flatMap((runtime) => {
        const sandboxId = runtime.recipe?.provider === 'orca-cloud' ? sandboxIdOf(runtime) : null
        // A create in flight is not listed yet; its own outcome settles the record.
        const creating = runtime.status === 'provisioning' || isEphemeralVmProvisionLive(runtime.id)
        return sandboxId &&
          runtime.cloudAccountId === account &&
          !RETIRED.has(runtime.status) &&
          !creating &&
          !listed.has(sandboxId)
          ? [{ runtime, sandboxId }]
          : []
      })
      const previous = missedOnce
      missedOnce = new Set(missing.map(({ sandboxId }) => sandboxId))
      for (const { runtime, sandboxId } of missing) {
        const gone = previous.has(sandboxId) || (await confirmedGone(sandboxId))
        // The confirming answer must still be for the team this list was for.
        if (!gone || deps.activeAccountId() !== account) {
          continue
        }
        try {
          await deps.retire(runtime)
          missedOnce.delete(sandboxId)
          deps.log?.(`[orca-cloud] retired ${runtime.workspaceName ?? runtime.id}: sandbox is gone`)
        } catch (error) {
          deps.log?.(`[orca-cloud] could not retire a gone sandbox's records: ${String(error)}`)
        }
      }
    }
  }
}
