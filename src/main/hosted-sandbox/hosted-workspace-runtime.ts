// Orca Cloud workspace lookups shared by the workspace service and its IPC: workspace id → runtime
// record → sandbox id, error mapping for the window, and OOM-notice dedupe.
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type {
  CloudOomEvent,
  CloudWorkspaceErrorCode,
  CloudWorkspaceResult
} from '../../shared/hosted-sandbox/cloud-workspace-api'
import type {
  HostedArchiveCheckout,
  HostedWorkspaceStatus
} from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  isEnvironmentProviderError,
  type EnvironmentProviderErrorCode
} from '../environment-providers/environment-provider-driver'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'
import type { HostedWorkspaceService } from './hosted-workspace-service'

export type CloudRuntime = { runtime: EphemeralVmRuntimeRecord; sandboxId: string }

let cachedCheckouts: ((workspaceId: string) => Promise<HostedArchiveCheckout[] | null>) | null =
  null
export function setArchiveCheckoutsProvider(
  provider: ((workspaceId: string) => Promise<HostedArchiveCheckout[] | null>) | null
): void {
  cachedCheckouts = provider
}

export function findCloudRuntime(userDataPath: string, workspaceId: string): CloudRuntime | null {
  for (const runtime of listEphemeralVmRuntimes(userDataPath)) {
    if (runtime.recipe?.provider !== 'orca-cloud' || runtime.workspaceId !== workspaceId) {
      continue
    }
    const handle = runtime.recipeResult
      ? environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
      : null
    const sandboxId = handle?.driverState.sandboxId
    if (typeof sandboxId === 'string' && sandboxId) {
      return { runtime, sandboxId }
    }
  }
  return null
}

export function failure<T>(error: unknown): CloudWorkspaceResult<T> {
  const codes: (CloudWorkspaceErrorCode & EnvironmentProviderErrorCode)[] = [
    'unauthorized',
    'entitlement_denied',
    'conflict',
    'not_found'
  ]
  for (const code of codes) {
    if (isEnvironmentProviderError(error, code)) {
      return { ok: false, code, message: error.message, reason: error.reason ?? null }
    }
  }
  if (
    isEnvironmentProviderError(error, 'unavailable') ||
    isEnvironmentProviderError(error, 'timeout')
  ) {
    return { ok: false, code: 'unavailable', message: error.message }
  }
  return {
    ok: false,
    code: 'failed',
    message: error instanceof Error ? error.message : String(error)
  }
}

export const NOT_CLOUD = {
  ok: false,
  code: 'not_cloud',
  message: 'Not an Orca Cloud workspace.'
} as const

export function readCachedCheckouts(workspaceId: string): Promise<HostedArchiveCheckout[] | null> {
  return cachedCheckouts ? cachedCheckouts(workspaceId).catch(() => null) : Promise.resolve(null)
}

/**
 * Announces each new kernel OOM kill once. The counter resets per VM boot; two readings belong to
 * one boot when their implied boot times agree within two minutes (uptime and checkedAt come from
 * different clocks).
 */
export function createOomTracker(announce: (event: CloudOomEvent) => void) {
  const seen = new Map<string, { bootAt: number; kills: number }>()
  return {
    observe(
      workspaceId: string,
      sandboxId: string,
      status: HostedWorkspaceStatus,
      now = Date.now()
    ): void {
      const metrics = status.metrics
      if (!metrics) {
        return
      }
      const bootAt = status.checkedAt - metrics.uptimeSeconds * 1000
      const previous = seen.get(sandboxId)
      const sameBoot = previous !== undefined && Math.abs(previous.bootAt - bootAt) < 120_000
      const announced = sameBoot ? previous.kills : 0
      seen.set(sandboxId, {
        bootAt: sameBoot ? previous.bootAt : bootAt,
        kills: Math.max(announced, metrics.oomKills)
      })
      if (metrics.oomKills > announced) {
        announce({
          workspaceId,
          oomKills: metrics.oomKills,
          victim: metrics.lastOomVictim,
          at: now
        })
      }
    },
    /** Forget sandboxes that are no longer running. */
    prune(live: ReadonlySet<string | undefined>): void {
      for (const sandboxId of seen.keys()) {
        if (!live.has(sandboxId)) {
          seen.delete(sandboxId)
        }
      }
    }
  }
}

let current: HostedWorkspaceService | null = null
export function setHostedWorkspaceService(next: HostedWorkspaceService | null): void {
  current = next
}
/** Null when Orca Cloud is not configured in this build. */
export function getHostedWorkspaceService(): HostedWorkspaceService | null {
  return current
}
