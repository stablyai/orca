// Orca Cloud workspace lookups shared by the workspace service and its IPC: workspace id → runtime
// record → sandbox id, error mapping for the window, and OOM-notice dedupe.
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type {
  CloudOomEvent,
  CloudWakeProgressEvent,
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
import { isHostedEntitlementDenied } from './hosted-environment-provider'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
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
  if (isHostedEntitlementDenied(error)) {
    return {
      ok: false,
      code: 'entitlement_denied',
      message: error.message,
      reason: error.reason ?? null
    }
  }
  const codes: (CloudWorkspaceErrorCode & EnvironmentProviderErrorCode)[] = [
    'unauthorized',
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

/** Cached repo state for an archive body, trimmed under the control plane's 256 KiB archive limit. */
export async function readCachedCheckouts(
  workspaceId: string
): Promise<HostedArchiveCheckout[] | null> {
  const checkouts = cachedCheckouts ? await cachedCheckouts(workspaceId).catch(() => null) : null
  return checkouts ? trimCheckouts(checkouts) : null
}

const MAX_ARCHIVE_BODY_BYTES = 200 * 1024

export function trimCheckouts(input: HostedArchiveCheckout[]): HostedArchiveCheckout[] {
  const kept = input.slice(0, 20).map((c) => ({ ...c, files: c.files.slice(0, 2000) }))
  const fits = (): boolean => JSON.stringify(kept).length <= MAX_ARCHIVE_BODY_BYTES
  for (let i = kept.length - 1; i >= 0 && !fits(); i--) {
    kept[i] = { ...kept[i]!, files: i === 0 ? kept[i]!.files.slice(0, 500) : [] }
  }
  for (let i = kept.length - 1; i >= 0 && !fits(); i--) {
    kept[i] = { ...kept[i]!, files: [], changes: kept[i]!.changes.slice(0, 50) }
  }
  while (kept.length > 1 && !fits()) {
    kept.pop()
  }
  return kept
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

/** Polls a cheap terminal listing until the woken server answers it (or the deadline passes). */
export async function waitForTerminalsReachable(
  userDataPath: string,
  environmentId: string,
  deadline: number,
  stillWanted: () => boolean = () => true
): Promise<boolean> {
  while (Date.now() < deadline && stillWanted()) {
    const remaining = deadline - Date.now()
    // Bounded by the deadline: the probe neither waits past it on a wake in flight nor on a slow server.
    const signal = AbortSignal.timeout(Math.max(1, remaining))
    const response = await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'terminal.list',
      { limit: 1 },
      Math.min(5_000, Math.max(1, remaining)),
      undefined,
      undefined,
      { signal, preparation: { recipeVmHoldMs: Math.max(0, remaining) } }
    ).catch(() => null)
    if (response?.ok) {
      return stillWanted()
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/**
 * After a wake's step answers: `ready` once the runtime record says running AND the woken server
 * answers a terminal listing (panes rebind to the restarted server's terminals a moment after
 * running; keys typed before that are dropped by design). `failed` when it never answers. Nothing
 * when this wake is no longer the current one (a newer wake, a failure or a Sleep took over).
 */
export async function announceWakeUsable(
  userDataPath: string,
  workspaceId: string,
  startedAt: number,
  hooks: { isCurrent: () => boolean; emit: (event: Omit<CloudWakeProgressEvent, 'at'>) => void },
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const running = (): EphemeralVmRuntimeRecord | null => {
    const runtime = findCloudRuntime(userDataPath, workspaceId)?.runtime
    return runtime?.status === 'running' ? runtime : null
  }
  while (Date.now() < deadline && hooks.isCurrent()) {
    const runtime = running()
    if (runtime) {
      const reachable = runtime.runtimeEnvironmentId
        ? await waitForTerminalsReachable(
            userDataPath,
            runtime.runtimeEnvironmentId,
            deadline,
            hooks.isCurrent
          )
        : true
      if (hooks.isCurrent() && running()) {
        hooks.emit(
          reachable
            ? { workspaceId, phase: 'ready', source: 'open', startedAt }
            : {
                workspaceId,
                phase: 'failed',
                source: 'open',
                startedAt,
                message: 'The workspace did not answer after waking.'
              }
        )
      }
      return
    }
    // Short beat: this sits on the wake's critical path until the runtime record flips to running.
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Whether the control plane says this workspace is archived; unknown counts as not archived. */
export async function isArchivedOnControlPlane(
  userDataPath: string,
  client: Pick<HostedSandboxControlPlaneClient, 'get'>,
  workspaceId: string
): Promise<boolean> {
  const found = findCloudRuntime(userDataPath, workspaceId)
  if (!found) {
    return false
  }
  try {
    return (await client.get(found.sandboxId)).status === 'archived'
  } catch {
    // The control plane refuses to resume an archive anyway.
    return false
  }
}

let archiveCheck: ((workspaceId: string) => Promise<boolean>) | null = null
/** Installed with Orca Cloud; the wake path asks it before resuming a cloud workspace. */
export function setCloudArchiveCheck(
  check: ((workspaceId: string) => Promise<boolean>) | null
): void {
  archiveCheck = check
}
/** False when Orca Cloud is off in this build. */
export function isCloudWorkspaceArchivedOnControlPlane(workspaceId: string): Promise<boolean> {
  return archiveCheck ? archiveCheck(workspaceId) : Promise.resolve(false)
}
