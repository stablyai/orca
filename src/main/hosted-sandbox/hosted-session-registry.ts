// One lease scheduler per running Orca Cloud workspace: renews Orca's lease, warns before the 24h
// cap, asks the window to sleep an idle workspace, and rolls the session over with agent auto-resume.
import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  ORCAD_WORK_VERDICT_METHOD,
  type HostedSessionWarningEvent
} from '../../shared/hosted-sandbox/hosted-session-events'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import { applyResumedRuntimePairing } from '../ephemeral-vm/runtime-resume-pairing'
import { noteRecipeVmWakePairing } from '../ephemeral-vm/recipe-vm-wake-pairings'
import { getEphemeralVmRecipeResultPairingCode } from '../../shared/ephemeral-vm-recipes'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import type { HostedEnvironmentProviderDriver } from './hosted-environment-provider'
import { autoResumeAgentsAfterRollover, listRestartOfferIds } from './hosted-agent-auto-resume'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'
import { createHostedRuntimeEnvironmentCall } from './hosted-runtime-environment-call'
import type { HostedActivitySample } from './hosted-session-lease-policy'
import { HostedSessionLeaseScheduler } from './hosted-session-lease-scheduler'

const WorkVerdict = z.object({
  verdict: z.enum(['idle', 'busy', 'unverifiable']),
  idleSince: z.number().nullable(),
  lastPtyInputAt: z.number().nullable()
})

type Running = { scheduler: HostedSessionLeaseScheduler; runtimeId: string }

export type HostedSessionRegistry = {
  /** Start schedulers for running Orca Cloud runtimes, stop the rest. Cheap; call after any lifecycle change. */
  sync(): Promise<void>
  stopEnvironment(environmentId: string): void
  dispose(): void
}

export function createHostedSessionRegistry(deps: {
  userDataPath: string
  driver: HostedEnvironmentProviderDriver
  windows: () => readonly BrowserWindow[]
  log?: (line: string) => void
}): HostedSessionRegistry {
  const running = new Map<string, Running>()
  const log = deps.log ?? ((line: string) => console.error(line))
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of deps.windows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  }

  async function start(runtime: EphemeralVmRuntimeRecord, environmentId: string): Promise<void> {
    const handle = runtime.recipeResult
      ? environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
      : null
    const runtimeEnvironmentId = runtime.runtimeEnvironmentId
    if (!handle || !runtimeEnvironmentId) {
      return
    }
    const status = await deps.driver.status(handle)
    if (status.status !== 'running' || !status.session || running.has(environmentId)) {
      return
    }
    const call = createHostedRuntimeEnvironmentCall(deps.userDataPath, runtimeEnvironmentId)
    const scheduler = new HostedSessionLeaseScheduler({
      driver: deps.driver,
      handle,
      session: status.session,
      log,
      readActivity: async (): Promise<HostedActivitySample> => {
        const response = await callRuntimeEnvironment(
          deps.userDataPath,
          runtimeEnvironmentId,
          ORCAD_WORK_VERDICT_METHOD,
          {},
          10_000
        )
        return response.ok
          ? WorkVerdict.parse(response.result)
          : { verdict: 'unverifiable', idleSince: null, lastPtyInputAt: null }
      },
      warn: (minutesLeft) => {
        log(
          `[orca-cloud] ${runtime.workspaceName ?? runtime.id}: session restarts in ${minutesLeft} min`
        )
        const event: HostedSessionWarningEvent = {
          workspaceId: runtime.workspaceId ?? null,
          workspaceName: runtime.workspaceName ?? null,
          minutesLeft
        }
        broadcast('orcaCloud:sessionWarning', event)
      },
      reconnect: async (ready) => {
        updateEphemeralVmRuntimeStatus(deps.userDataPath, runtime.id, {
          recipeResult: ready.result
        })
        const { environment } = await applyResumedRuntimePairing({
          userDataPath: deps.userDataPath,
          environmentId: runtimeEnvironmentId,
          pairingCode: getEphemeralVmRecipeResultPairingCode(ready.result) ?? '',
          invalidateTransport: invalidateRuntimeEnvironmentTransport
        })
        noteRecipeVmWakePairing(
          environment.id,
          environment.pairingRevision ?? environment.createdAt,
          true
        )
      },
      snapshotOffers: () => listRestartOfferIds(call),
      resumeAgents: (drainStartedAt, offersBeforeDrain) =>
        autoResumeAgentsAfterRollover(call, drainStartedAt, offersBeforeDrain),
      // The window runs its ordinary Sleep, so the sidebar, chats and VM suspend stay one path.
      onSuspended: () =>
        log(`[orca-cloud] idle sleep requested for ${runtime.workspaceName ?? runtime.id}`),
      suspend: async () => {
        broadcast('orcaCloud:idleSleepRequested', { workspaceId: runtime.workspaceId ?? null })
      }
    })
    running.set(environmentId, { scheduler, runtimeId: runtime.id })
    scheduler.start()
    log(`[orca-cloud] lease scheduler started for ${runtime.workspaceName ?? runtime.id}`)
  }

  function stopEnvironment(environmentId: string): void {
    running.get(environmentId)?.scheduler.stop()
    running.delete(environmentId)
  }

  return {
    async sync() {
      const live = new Set<string>()
      for (const runtime of listEphemeralVmRuntimes(deps.userDataPath)) {
        if (
          runtime.recipe?.provider !== 'orca-cloud' ||
          runtime.status !== 'running' ||
          !runtime.recipeResult
        ) {
          continue
        }
        const handle = environmentHandleFromRecipeResult(
          runtime.recipeResult,
          HOSTED_SANDBOX_DRIVER_ID
        )
        if (!handle) {
          continue
        }
        live.add(handle.environmentId)
        await start(runtime, handle.environmentId).catch((error: unknown) =>
          log(`[orca-cloud] could not start lease scheduler: ${String(error)}`)
        )
      }
      for (const environmentId of running.keys()) {
        if (!live.has(environmentId)) {
          stopEnvironment(environmentId)
        }
      }
    },
    stopEnvironment,
    dispose() {
      for (const environmentId of running.keys()) {
        stopEnvironment(environmentId)
      }
    }
  }
}
