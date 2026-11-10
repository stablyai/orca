import { app, BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { listCredentialLikeEnvNames } from '../../shared/ephemeral-vm-recipe-env'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import {
  EPHEMERAL_VM_RUNTIMES_CHANGED_CHANNEL,
  onEphemeralVmRuntimesChanged
} from '../../shared/ephemeral-vm-runtime-store-events'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { cleanupOwnedEphemeralVmRuntime } from '../ephemeral-vm/owned-runtime-cleanup'
import { stopEphemeralVmRuntimeCleanup } from '../ephemeral-vm/runtime-cleanup-control'
import {
  buildEphemeralVmRecipeCleanupCommand,
  buildEphemeralVmRecipeCleanupPayload
} from '../../shared/ephemeral-vm-recipe-lifecycle-payload'
import { getRuntimeRecipeContext } from './ephemeral-vm-recipe-context'
import { ephemeralVmFailure } from '../../shared/ephemeral-vm-failure-copy'
import { attachEphemeralVmRuntimeToWorkspace } from '../ephemeral-vm/runtime-attachment'
import { forgetInterruptedEphemeralVmProvision } from '../ephemeral-vm/runtime-provisioning-persistence'
import { pendingVmCheckouts } from '../ephemeral-vm/pending-vm-checkouts'
import {
  parsePendingVmCheckouts,
  PENDING_VM_CHECKOUTS_CHANGED_CHANNEL
} from '../../shared/pending-vm-checkouts'

let stopRuntimesChangedBroadcast: (() => void) | null = null
let runtimesChangedBroadcastQueued = false

/** One coalesced signal per tick: a lifecycle op writes the store several times. */
function broadcastEphemeralVmRuntimesChanged(): void {
  if (runtimesChangedBroadcastQueued) {
    return
  }
  runtimesChangedBroadcastQueued = true
  setImmediate(() => {
    runtimesChangedBroadcastQueued = false
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) {
        continue
      }
      try {
        window.webContents.send(EPHEMERAL_VM_RUNTIMES_CHANGED_CHANNEL)
      } catch {
        // A renderer can disappear between isDestroyed() and send().
      }
    }
  })
}

export type EphemeralVmCleanupCommandResult = {
  runtimeId: string
  command: string | null
  payloadJson: string
  cleanupDisabled: boolean
  message?: string
}

let detachPendingCheckoutBroadcast: (() => void) | null = null
const pendingCheckoutOwners = new Set<number>()

function broadcastPendingVmCheckouts(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(
        PENDING_VM_CHECKOUTS_CHANGED_CHANNEL,
        pendingVmCheckouts.listExcept(window.webContents.id)
      )
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

/** Windows publish the VM checkouts their creates have not adopted yet; every window reads the union. */
function registerPendingVmCheckoutHandlers(): void {
  ipcMain.removeHandler('ephemeralVm:publishPendingCheckouts')
  ipcMain.removeHandler('ephemeralVm:listPendingCheckouts')
  detachPendingCheckoutBroadcast?.()
  detachPendingCheckoutBroadcast = pendingVmCheckouts.onChanged(broadcastPendingVmCheckouts)
  ipcMain.handle('ephemeralVm:publishPendingCheckouts', (event, value: unknown): void => {
    const sender = event.sender
    const ownerId = sender.id
    if (!pendingCheckoutOwners.has(ownerId)) {
      pendingCheckoutOwners.add(ownerId)
      // A closed or crashed window's creates cannot finish; its hides go with it. A reloaded
      // window publishes its empty set when it starts.
      const drop = (): void => {
        pendingCheckoutOwners.delete(ownerId)
        sender.removeListener('render-process-gone', drop)
        pendingVmCheckouts.publish(ownerId, [])
      }
      sender.once('destroyed', drop)
      sender.once('render-process-gone', drop)
    }
    pendingVmCheckouts.publish(ownerId, parsePendingVmCheckouts(value))
  })
  ipcMain.handle('ephemeralVm:listPendingCheckouts', (event) =>
    pendingVmCheckouts.listExcept(event.sender.id)
  )
}

export function registerEphemeralVmRuntimeHandlers(store: Store): void {
  registerPendingVmCheckoutHandlers()
  ipcMain.removeHandler('ephemeralVm:attachWorkspace')
  ipcMain.removeHandler('ephemeralVm:listRuntimes')
  ipcMain.removeHandler('ephemeralVm:cleanup')
  ipcMain.removeHandler('ephemeralVm:stopCleanup')
  ipcMain.removeHandler('ephemeralVm:forgetRuntime')
  ipcMain.removeHandler('ephemeralVm:getCleanupCommand')
  ipcMain.removeHandler('ephemeralVm:listCredentialEnvNames')
  stopRuntimesChangedBroadcast?.()
  stopRuntimesChangedBroadcast = onEphemeralVmRuntimesChanged(broadcastEphemeralVmRuntimesChanged)

  // Names only: the recipe list warns which credentials scripts inherit, never their values.
  ipcMain.handle('ephemeralVm:listCredentialEnvNames', () =>
    listCredentialLikeEnvNames(process.env)
  )

  ipcMain.handle('ephemeralVm:listRuntimes', (): EphemeralVmRuntimeRecord[] => {
    return listEphemeralVmRuntimes(app.getPath('userData'))
  })

  ipcMain.handle(
    'ephemeralVm:attachWorkspace',
    (_event, args: { runtimeId: string; workspaceId: string }): EphemeralVmRuntimeRecord => {
      return attachEphemeralVmRuntimeToWorkspace({
        userDataPath: app.getPath('userData'),
        runtimeId: args.runtimeId,
        workspaceId: args.workspaceId
      })
    }
  )

  ipcMain.handle(
    'ephemeralVm:cleanup',
    async (_event, args: { runtimeId: string }): Promise<EphemeralVmRuntimeRecord> => {
      return cleanupOwnedEphemeralVmRuntime(store, app.getPath('userData'), args.runtimeId)
    }
  )

  ipcMain.handle(
    'ephemeralVm:stopCleanup',
    async (_event, args: { runtimeId: string }): Promise<EphemeralVmRuntimeRecord> => {
      const userDataPath = app.getPath('userData')
      const stopping = stopEphemeralVmRuntimeCleanup({
        userDataPath,
        runtimeId: args.runtimeId
      })
      if (stopping) {
        return (await stopping).runtime
      }

      const runtime = listEphemeralVmRuntimes(userDataPath).find(
        (entry) => entry.id === args.runtimeId
      )
      if (!runtime) {
        throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
      }
      if (runtime.cleanupStatus !== 'running') {
        return runtime
      }
      return updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
        status: 'cleanup_failed',
        cleanupStatus: 'failed',
        cleanupLastError: ephemeralVmFailure('cleanupInterrupted')
      })
    }
  )

  ipcMain.handle('ephemeralVm:forgetRuntime', (_event, args: { runtimeId: string }): void => {
    forgetInterruptedEphemeralVmProvision(app.getPath('userData'), args.runtimeId)
  })

  ipcMain.handle(
    'ephemeralVm:getCleanupCommand',
    async (_event, args: { runtimeId: string }): Promise<EphemeralVmCleanupCommandResult> => {
      const userDataPath = app.getPath('userData')
      const resolved = getRuntimeRecipeContext(store, userDataPath, args.runtimeId)
      const payload = buildEphemeralVmRecipeCleanupPayload({
        recipe: resolved.recipe,
        context: {
          instanceId: resolved.runtime.id,
          recipeId: resolved.runtime.recipeId,
          projectId: resolved.runtime.projectId,
          workspaceId: resolved.runtime.workspaceId,
          workspaceName: resolved.runtime.workspaceName,
          repoPath: resolved.repoPath
        },
        recipeResult: resolved.runtime.recipeResult
      })
      const payloadJson = JSON.stringify(payload, null, 2)
      if (resolved.recipe.destroyDisabled || !resolved.recipe.destroy) {
        return {
          runtimeId: resolved.runtime.id,
          command: null,
          payloadJson,
          cleanupDisabled: true,
          message: 'Destroy is disabled for this recipe.'
        }
      }
      return {
        runtimeId: resolved.runtime.id,
        command: buildEphemeralVmRecipeCleanupCommand({
          destroyCommand: resolved.recipe.destroy,
          payload
        }),
        payloadJson,
        cleanupDisabled: false
      }
    }
  )
}
