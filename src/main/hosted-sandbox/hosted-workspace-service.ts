// Orca Cloud workspace surfaces for the window: status panel, Restart, archive/unarchive, wake
// progress and OOM notices. Maps the renderer's workspace id to its Orca Cloud runtime record.
import { ipcMain, type BrowserWindow } from 'electron'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import {
  ORCA_CLOUD_WORKSPACE_CHANNELS as CH,
  type CloudWakeProgressEvent,
  type CloudWakeSource
} from '../../shared/hosted-sandbox/cloud-workspace-api'
import type {
  HostedArchivePullRequest,
  HostedSandboxReadyResponse
} from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import { applyResumedRuntimePairing } from '../ephemeral-vm/runtime-resume-pairing'
import { noteRecipeVmWakePairing } from '../ephemeral-vm/recipe-vm-wake-pairings'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import { autoResumeAgentsAfterRollover } from './hosted-agent-auto-resume'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { toReady } from './hosted-sandbox-driver'
import { createHostedRuntimeEnvironmentCall } from './hosted-runtime-environment-call'
import {
  NOT_CLOUD,
  createOomTracker,
  failure,
  findCloudRuntime,
  readCachedCheckouts,
  type CloudRuntime
} from './hosted-workspace-runtime'

export {
  findCloudRuntime,
  getHostedWorkspaceService,
  setArchiveCheckoutsProvider,
  setHostedWorkspaceService
} from './hosted-workspace-runtime'

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
export function installHostedWorkspaceService(deps: {
  userDataPath: string
  client: HostedSandboxControlPlaneClient
  windows: () => readonly BrowserWindow[]
  /** Restart lease schedulers after a lifecycle change. */
  syncSessions: () => void
  /** Stop the lease scheduler of one environment (its session is about to be replaced). */
  stopSession: (environmentId: string) => void
  log?: (line: string) => void
}): HostedWorkspaceService {
  const log = deps.log ?? ((line: string) => console.error(line))
  const wakeSources = new Map<string, CloudWakeSource>()
  // Wakes in flight per workspace, so every phase carries the source the first one named.
  const wakes = new Map<string, { source: CloudWakeSource; startedAt: number }>()
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of deps.windows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  }
  const oom = createOomTracker((event) => broadcast(CH.oom, event))

  async function reconnect(found: CloudRuntime, ready: HostedSandboxReadyResponse): Promise<void> {
    const runtimeEnvironmentId = found.runtime.runtimeEnvironmentId
    updateEphemeralVmRuntimeStatus(deps.userDataPath, found.runtime.id, {
      status: 'running',
      recipeResult: toReady(ready).result
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

  /** The step answers before the window re-pairs; `ready` fires once the runtime record says running. */
  async function announceReadyWhenRunning(workspaceId: string, startedAt: number): Promise<void> {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && wakes.has(workspaceId)) {
      const runtime = findCloudRuntime(deps.userDataPath, workspaceId)?.runtime
      if (runtime?.status === 'running') {
        service.emitWakeProgress({ workspaceId, phase: 'ready', source: 'open', startedAt })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  const service: HostedWorkspaceService = {
    emitWakeProgress(event) {
      if (event.phase === 'waking') {
        wakes.set(event.workspaceId, { source: event.source, startedAt: event.startedAt })
      }
      const inFlight = wakes.get(event.workspaceId)
      const source = inFlight?.source ?? event.source
      if (event.phase === 'ready' || event.phase === 'failed') {
        wakes.delete(event.workspaceId)
      }
      broadcast(CH.wakeProgress, {
        ...event,
        source,
        at: Date.now()
      } satisfies CloudWakeProgressEvent)
      if (event.phase === 'connecting' && event.source !== 'restart') {
        void announceReadyWhenRunning(event.workspaceId, event.startedAt)
      }
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
      const live = new Set(
        listEphemeralVmRuntimes(deps.userDataPath)
          .filter(
            (runtime) =>
              runtime.recipe?.provider === 'orca-cloud' &&
              runtime.status === 'running' &&
              runtime.workspaceId
          )
          .map((runtime) => findCloudRuntime(deps.userDataPath, runtime.workspaceId!)?.sandboxId)
      )
      oom.prune(live)
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
          oom.observe(runtime.workspaceId, found.sandboxId, status)
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
      oom.observe(args.workspaceId, found.sandboxId, status)
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
    // The scheduler holds the old session's deadline and would warn/roll over the new one; a fresh one starts on sync.
    deps.stopSession(found.sandboxId)
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
      deps.syncSessions()
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
        const checkouts = (await readCachedCheckouts(args.workspaceId)) ?? undefined
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
      deps.syncSessions()
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
