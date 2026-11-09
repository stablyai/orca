// Orca Cloud workspace surfaces for the window: status panel, Restart, archive/unarchive, wake
// progress and OOM notices. Maps the renderer's workspace id to its Orca Cloud runtime record.
import { ipcMain, type BrowserWindow } from 'electron'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  ORCA_CLOUD_WORKSPACE_CHANNELS as CH,
  type CloudOomEvent,
  type CloudWakeProgressEvent,
  type CloudWakeSource,
  type CloudWorkspaceErrorCode,
  type CloudWorkspaceResult
} from '../../shared/hosted-sandbox/cloud-workspace-api'
import type {
  HostedArchiveCheckout,
  HostedArchivePullRequest,
  HostedSandboxReadyResponse,
  HostedWorkspaceStatus
} from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  isEnvironmentProviderError,
  type EnvironmentProviderErrorCode
} from '../environment-providers/environment-provider-driver'
import {
  environmentHandleFromRecipeResult,
  environmentReadyToRecipeResult
} from '../environment-providers/environment-provider-recipe-adapter'
import { applyResumedRuntimePairing } from '../ephemeral-vm/runtime-resume-pairing'
import { noteRecipeVmWakePairing } from '../ephemeral-vm/recipe-vm-wake-pairings'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import { autoResumeAgentsAfterRollover } from './hosted-agent-auto-resume'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { HOSTED_SANDBOX_DRIVER_ID, toReady } from './hosted-sandbox-driver'
import { createHostedRuntimeEnvironmentCall } from './hosted-runtime-environment-call'

type CloudRuntime = { runtime: EphemeralVmRuntimeRecord; sandboxId: string }

export type HostedWorkspaceService = {
  emitWakeProgress(event: Omit<CloudWakeProgressEvent, 'at'>): void
  /** Who asked for the next wake of this workspace (message/ssh/preview); read once by the step. */
  noteWakeSource(workspaceId: string, source: CloudWakeSource): void
  takeWakeSource(workspaceId: string): CloudWakeSource
  /** One OOM check for every running cloud workspace (the install beat calls it). */
  pollOom(): Promise<void>
  dispose(): void
}

/** Git state from the client-side offline cache, used when archiving a VM that is already asleep. */
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

function failure<T>(error: unknown): CloudWorkspaceResult<T> {
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

const NOT_CLOUD = {
  ok: false,
  code: 'not_cloud',
  message: 'Not an Orca Cloud workspace.'
} as const

export function installHostedWorkspaceService(deps: {
  userDataPath: string
  client: HostedSandboxControlPlaneClient
  windows: () => readonly BrowserWindow[]
  /** Restart lease schedulers after a lifecycle change. */
  syncSessions: () => void
  log?: (line: string) => void
}): HostedWorkspaceService {
  const log = deps.log ?? ((line: string) => console.error(line))
  const wakeSources = new Map<string, CloudWakeSource>()
  // Last OOM-kill count seen per sandbox session, so a banner fires once per new kill.
  const oomSeen = new Map<string, number>()
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of deps.windows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  }

  function noticeOom(workspaceId: string, sandboxId: string, status: HostedWorkspaceStatus): void {
    const metrics = status.metrics
    if (!metrics) {
      return
    }
    // Per boot: uptime resets with each session, so key by sandbox and boot time (minute precision).
    const bootKey = `${sandboxId}:${Math.round((status.checkedAt - metrics.uptimeSeconds * 1000) / 60_000)}`
    const seen = oomSeen.get(bootKey) ?? 0
    if (metrics.oomKills > seen) {
      oomSeen.set(bootKey, metrics.oomKills)
      const event: CloudOomEvent = {
        workspaceId,
        oomKills: metrics.oomKills,
        victim: metrics.lastOomVictim,
        at: Date.now()
      }
      broadcast(CH.oom, event)
    }
  }

  async function reconnect(found: CloudRuntime, ready: HostedSandboxReadyResponse): Promise<void> {
    const runtimeEnvironmentId = found.runtime.runtimeEnvironmentId
    updateEphemeralVmRuntimeStatus(deps.userDataPath, found.runtime.id, {
      status: 'running',
      recipeResult: environmentReadyToRecipeResult(toReady(ready), 'orca-worktree')
    })
    if (!runtimeEnvironmentId) {
      return
    }
    const { environment } = await applyResumedRuntimePairing({
      userDataPath: deps.userDataPath,
      environmentId: runtimeEnvironmentId,
      pairingCode: ready.connection.pairingCode,
      invalidateTransport: invalidateRuntimeEnvironmentTransport
    })
    noteRecipeVmWakePairing(
      environment.id,
      environment.pairingRevision ?? environment.createdAt,
      true
    )
  }

  const service: HostedWorkspaceService = {
    emitWakeProgress(event) {
      broadcast(CH.wakeProgress, { ...event, at: Date.now() } satisfies CloudWakeProgressEvent)
    },
    noteWakeSource(workspaceId, source) {
      wakeSources.set(workspaceId, source)
    },
    takeWakeSource(workspaceId) {
      const source = wakeSources.get(workspaceId) ?? 'open'
      wakeSources.delete(workspaceId)
      return source
    },
    async pollOom() {
      for (const runtime of listEphemeralVmRuntimes(deps.userDataPath)) {
        if (
          runtime.recipe?.provider !== 'orca-cloud' ||
          runtime.status !== 'running' ||
          !runtime.workspaceId
        ) {
          continue
        }
        const found = findCloudRuntime(deps.userDataPath, runtime.workspaceId)
        if (!found) {
          continue
        }
        try {
          const { status } = await deps.client.workspaceStatus(found.sandboxId)
          noticeOom(runtime.workspaceId, found.sandboxId, status)
        } catch {
          // Status is advisory; the next beat retries.
        }
      }
    },
    dispose() {
      for (const channel of [
        CH.getStatus,
        CH.restart,
        CH.archive,
        CH.unarchive,
        CH.getArchive,
        CH.listCloudWorkspaceIds
      ]) {
        ipcMain.removeHandler(channel)
      }
    }
  }

  service.dispose()
  ipcMain.handle(CH.listCloudWorkspaceIds, () =>
    listEphemeralVmRuntimes(deps.userDataPath)
      .filter((runtime) => runtime.recipe?.provider === 'orca-cloud' && runtime.workspaceId)
      .map((runtime) => runtime.workspaceId!)
  )

  ipcMain.handle(CH.getStatus, async (_event, args: { workspaceId: string }) => {
    const found = findCloudRuntime(deps.userDataPath, args.workspaceId)
    if (!found) {
      return NOT_CLOUD
    }
    try {
      const { status } = await deps.client.workspaceStatus(found.sandboxId)
      noticeOom(args.workspaceId, found.sandboxId, status)
      return { ok: true, value: status }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(CH.restart, async (_event, args: { workspaceId: string }) => {
    const found = findCloudRuntime(deps.userDataPath, args.workspaceId)
    if (!found) {
      return NOT_CLOUD
    }
    const startedAt = Date.now()
    service.emitWakeProgress({
      workspaceId: args.workspaceId,
      phase: 'waking',
      source: 'restart',
      startedAt
    })
    try {
      const ready = await deps.client.restart(found.sandboxId)
      service.emitWakeProgress({
        workspaceId: args.workspaceId,
        phase: 'connecting',
        source: 'restart',
        startedAt
      })
      await reconnect(found, ready)
      deps.syncSessions()
      service.emitWakeProgress({
        workspaceId: args.workspaceId,
        phase: 'ready',
        source: 'restart',
        startedAt
      })
      if (found.runtime.runtimeEnvironmentId) {
        // Same continuation as a rollover: chats the restart interrupted carry on by themselves.
        const call = createHostedRuntimeEnvironmentCall(
          deps.userDataPath,
          found.runtime.runtimeEnvironmentId
        )
        void autoResumeAgentsAfterRollover(call, startedAt).catch((error: unknown) =>
          log(`[orca-cloud] auto-resume after restart failed: ${String(error)}`)
        )
      }
      return { ok: true, value: null }
    } catch (error) {
      service.emitWakeProgress({
        workspaceId: args.workspaceId,
        phase: 'failed',
        source: 'restart',
        startedAt,
        message: error instanceof Error ? error.message : String(error)
      })
      return failure(error)
    }
  })

  ipcMain.handle(
    CH.archive,
    async (_event, args: { workspaceId: string; pullRequests?: HostedArchivePullRequest[] }) => {
      const found = findCloudRuntime(deps.userDataPath, args.workspaceId)
      if (!found) {
        return NOT_CLOUD
      }
      try {
        const checkouts = (await cachedCheckouts?.(args.workspaceId).catch(() => null)) ?? undefined
        await deps.client.archive(found.sandboxId, {
          ...(args.pullRequests?.length ? { pullRequests: args.pullRequests.slice(0, 50) } : {}),
          ...(checkouts?.length ? { checkouts: checkouts.slice(0, 20) } : {})
        })
        updateEphemeralVmRuntimeStatus(deps.userDataPath, found.runtime.id, { status: 'suspended' })
        deps.syncSessions()
        return { ok: true, value: null }
      } catch (error) {
        return failure(error)
      }
    }
  )

  ipcMain.handle(CH.unarchive, async (_event, args: { workspaceId: string }) => {
    const found = findCloudRuntime(deps.userDataPath, args.workspaceId)
    if (!found) {
      return NOT_CLOUD
    }
    const startedAt = Date.now()
    service.emitWakeProgress({
      workspaceId: args.workspaceId,
      phase: 'waking',
      source: 'unarchive',
      startedAt
    })
    try {
      // The control plane resumes the disk; the window then runs its ordinary wake, which re-pairs.
      await deps.client.unarchive(found.sandboxId)
      return { ok: true, value: null }
    } catch (error) {
      service.emitWakeProgress({
        workspaceId: args.workspaceId,
        phase: 'failed',
        source: 'unarchive',
        startedAt,
        message: error instanceof Error ? error.message : String(error)
      })
      return failure(error)
    }
  })

  ipcMain.handle(CH.getArchive, async (_event, args: { workspaceId: string }) => {
    const found = findCloudRuntime(deps.userDataPath, args.workspaceId)
    if (!found) {
      return NOT_CLOUD
    }
    try {
      return { ok: true, value: await deps.client.archiveInfo(found.sandboxId) }
    } catch (error) {
      return failure(error)
    }
  })

  return service
}

let current: HostedWorkspaceService | null = null
export function setHostedWorkspaceService(next: HostedWorkspaceService | null): void {
  current = next
}
/** Null when Orca Cloud is not configured in this build. */
export function getHostedWorkspaceService(): HostedWorkspaceService | null {
  return current
}
