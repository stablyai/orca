import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultConnection } from '../../shared/ephemeral-vm-recipes'
import { removeEnvironment } from '../../shared/runtime-environment-store'
import {
  cleanupEphemeralVmRuntime,
  resumeEphemeralVmRuntime,
  suspendEphemeralVmRuntime
} from '../ephemeral-vm-runtime-service'
import { attachEphemeralVmRuntimeToWorkspace } from '../ephemeral-vm-runtime-attachment'
import { resumeEphemeralVmRuntimeEnvironment } from '../ephemeral-vm-runtime-environment-resume'
import {
  continueEphemeralVmRuntimeResume,
  createEphemeralVmRuntimeResumeCoordinator
} from '../ephemeral-vm-runtime-resume-continuation'
import { removeEphemeralVmRuntimeSshTarget } from '../ephemeral-vm-runtime-ssh-cleanup'
import {
  buildEphemeralVmRecipeCleanupCommand,
  buildEphemeralVmRecipeCleanupPayload
} from '../ephemeral-vm-recipe-runner'
import {
  connectRuntimeOwnedSshTarget,
  disconnectRuntimeOwnedSshTarget,
  removeRuntimeOwnedSshTarget
} from '../ephemeral-vm-runtime-ssh'
import { getRuntimeRecipeContext } from './ephemeral-vm-recipe-context'
import { invalidateRuntimeEnvironmentTransport } from './runtime-environments'

export type EphemeralVmCleanupCommandResult = {
  runtimeId: string
  command: string | null
  payloadJson: string
  cleanupDisabled: boolean
  message?: string
}

export function registerEphemeralVmRuntimeHandlers(store: Store): void {
  const coordinateRuntimeResume = createEphemeralVmRuntimeResumeCoordinator()
  ipcMain.removeHandler('ephemeralVm:attachWorkspace')
  ipcMain.removeHandler('ephemeralVm:listRuntimes')
  ipcMain.removeHandler('ephemeralVm:cleanup')
  ipcMain.removeHandler('ephemeralVm:suspendWorkspace')
  ipcMain.removeHandler('ephemeralVm:resumeWorkspace')
  ipcMain.removeHandler('ephemeralVm:getCleanupCommand')

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
      const userDataPath = app.getPath('userData')
      const runtime = listEphemeralVmRuntimes(userDataPath).find(
        (entry) => entry.id === args.runtimeId
      )
      if (!runtime) {
        throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
      }
      if (!runtime.repoId) {
        throw new Error(`Ephemeral VM runtime has no repo id: ${args.runtimeId}`)
      }
      let result
      if (runtime.cleanupStatus === 'succeeded') {
        result = { ok: true as const, runtime, skipped: false }
      } else {
        let resolved: ReturnType<typeof getRuntimeRecipeContext>
        try {
          resolved = getRuntimeRecipeContext(store, userDataPath, runtime.id)
        } catch (error) {
          return updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
            status: 'cleanup_failed',
            cleanupStatus: 'failed',
            cleanupLastAttemptAt: Date.now(),
            cleanupLastError: error instanceof Error ? error.message : String(error)
          })
        }
        result = await cleanupEphemeralVmRuntime({
          userDataPath,
          repoPath: resolved.repo.repo.path,
          recipe: resolved.recipe,
          runtimeId: runtime.id
        })
      }
      if (result.ok && runtime.runtimeEnvironmentId) {
        try {
          removeEnvironment(userDataPath, runtime.runtimeEnvironmentId)
        } catch {
          // Cleanup of provider resources matters more than hiding a stale local
          // environment row; users can still remove that manually.
        }
      }
      // Remove even on cleanup_failed (removal is idempotent via the deterministic
      // id) so a terminal cleanup never orphans the hidden SSH target.
      return removeEphemeralVmRuntimeSshTarget({
        userDataPath,
        runtime: result.runtime,
        removeTarget: removeRuntimeOwnedSshTarget
      })
    }
  )

  ipcMain.handle(
    'ephemeralVm:suspendWorkspace',
    async (_event, args: { workspaceId: string }): Promise<EphemeralVmRuntimeRecord | null> => {
      const userDataPath = app.getPath('userData')
      const runtime = listEphemeralVmRuntimes(userDataPath).find(
        (entry) =>
          entry.workspaceId === args.workspaceId &&
          entry.status !== 'cleaned' &&
          entry.status !== 'cleanup_pending'
      )
      if (!runtime?.repoId) {
        return null
      }
      const recipeContext = getRuntimeRecipeContext(store, userDataPath, runtime.id)
      const result = await suspendEphemeralVmRuntime({
        userDataPath,
        repoPath: recipeContext.repo.repo.path,
        recipe: recipeContext.recipe,
        runtimeId: runtime.id
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      // Only tear down SSH for a real suspend; a skipped suspend keeps the runtime
      // 'running', so disconnecting would break the still-active session with no resume.
      if (runtime.connectionMode === 'ssh' && !result.skipped) {
        // Why: the suspend recipe already succeeded (VM is suspended), so a failed
        // LOCAL relay teardown must NOT flip to 'suspend_failed' — that status is not
        // resume-eligible (see resume gate below), which would strand the runtime
        // unrecoverable. Keep 'suspended'; resume re-establishes the relay anyway.
        await disconnectRuntimeOwnedSshTarget(runtime.sshTargetId).catch(() => undefined)
      }
      return result.runtime
    }
  )

  ipcMain.handle(
    'ephemeralVm:resumeWorkspace',
    async (_event, args: { workspaceId: string }): Promise<EphemeralVmRuntimeRecord | null> => {
      const userDataPath = app.getPath('userData')
      const runtime = listEphemeralVmRuntimes(userDataPath).find(
        (entry) =>
          entry.workspaceId === args.workspaceId &&
          entry.status !== 'cleaned' &&
          entry.status !== 'cleanup_pending'
      )
      if (!runtime?.repoId) {
        return null
      }
      const retryConnection = runtime.resumeConnectionPending === true
      if (
        runtime.status !== 'suspended' &&
        runtime.status !== 'resume_failed' &&
        !retryConnection
      ) {
        return runtime
      }
      return coordinateRuntimeResume(runtime.id, async () => {
        const result = await continueEphemeralVmRuntimeResume(runtime, async () => {
          const recipeContext = getRuntimeRecipeContext(store, userDataPath, runtime.id)
          return resumeEphemeralVmRuntime({
            userDataPath,
            repoPath: recipeContext.repo.repo.path,
            recipe: recipeContext.recipe,
            runtimeId: runtime.id
          })
        })
        if (!result.ok) {
          throw new Error(result.error)
        }
        if (result.skipped) {
          return result.runtime
        }
        const connection = getEphemeralVmRecipeResultConnection(result.runtime.recipeResult)
        if (connection.type === 'orca-server') {
          if (!runtime.runtimeEnvironmentId) {
            updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
              status: 'resume_failed',
              resumeConnectionPending: true
            })
            throw new Error('Ephemeral VM runtime has no runtime environment to reconnect.')
          }
          return resumeEphemeralVmRuntimeEnvironment({
            userDataPath,
            environmentId: runtime.runtimeEnvironmentId,
            runtime: result.runtime,
            invalidateTransport: invalidateRuntimeEnvironmentTransport
          })
        }
        if (connection.type === 'ssh') {
          try {
            const ssh = await connectRuntimeOwnedSshTarget({
              runtimeId: result.runtime.id,
              connection
            })
            return updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
              status: 'running',
              resumeConnectionPending: false,
              connectionMode: 'ssh',
              sshTargetId: ssh.targetId
            })
          } catch (error) {
            updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
              status: 'resume_failed',
              resumeConnectionPending: true
            })
            throw error
          }
        }
        return result.runtime
      })
    }
  )

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
          repoUrl: resolved.runtime.repoUrl,
          branch: resolved.runtime.branch,
          ref: resolved.runtime.ref,
          orcaVersion: resolved.runtime.orcaVersion,
          repoPath: resolved.repo.repo.path
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
