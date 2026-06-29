import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { loadHooks } from '../hooks'
import {
  doctorEphemeralVmRecipe,
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  type EphemeralVmRecipeResultWarning,
  type EphemeralVmRecipeDoctorResult
} from '../../shared/ephemeral-vm-recipes'
import { updateEphemeralVmRuntimeStatus } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime
} from '../ephemeral-vm-runtime-service'
import { connectRuntimeOwnedSshTarget } from '../ephemeral-vm-runtime-ssh'
import {
  getRecipeRepo,
  listRecipeCatalog,
  listRecipes,
  type EphemeralVmRecipeCatalogEntry
} from './ephemeral-vm-recipe-context'
import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'

const activeProvisionControllers = new Map<string, AbortController>()

export type EphemeralVmProvisionIpcResult =
  | {
      ok: true
      connectionType: 'orca-server'
      runtime: EphemeralVmRuntimeRecord
      environment: PublicKnownRuntimeEnvironment
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: true
      connectionType: 'ssh'
      runtime: EphemeralVmRuntimeRecord
      sshTargetId: string
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: false
      error: string
      stderr: string
      stdout: string
    }

export function registerEphemeralVmHandlers(store: Store): void {
  ipcMain.removeHandler('ephemeralVm:listRecipes')
  ipcMain.removeHandler('ephemeralVm:listRecipeCatalog')
  ipcMain.removeHandler('ephemeralVm:doctor')
  ipcMain.removeHandler('ephemeralVm:provision')
  ipcMain.removeHandler('ephemeralVm:cancelProvision')
  registerEphemeralVmRuntimeHandlers(store)

  ipcMain.handle('ephemeralVm:listRecipes', (_event, args: { repoId: string }) => {
    return listRecipes(store, args.repoId)
  })

  ipcMain.handle('ephemeralVm:listRecipeCatalog', (): EphemeralVmRecipeCatalogEntry[] => {
    return listRecipeCatalog(store)
  })

  ipcMain.handle(
    'ephemeralVm:doctor',
    (_event, args: { repoId: string; recipeId: string }): EphemeralVmRecipeDoctorResult => {
      const repo = getRecipeRepo(store, args.repoId)
      if (!repo.ok) {
        return repo.doctor(args.recipeId)
      }
      return doctorEphemeralVmRecipe({
        repoPath: repo.repo.path,
        recipeId: args.recipeId,
        recipes: loadHooks(repo.repo.path)?.vmRecipes ?? [],
        localExecutionSupported: true
      })
    }
  )

  ipcMain.handle(
    'ephemeralVm:provision',
    async (
      _event,
      args: {
        repoId: string
        recipeId: string
        workspaceName?: string
        projectId?: string
        workspaceId?: string
        provisionId?: string
      }
    ): Promise<EphemeralVmProvisionIpcResult> => {
      const repo = getRecipeRepo(store, args.repoId)
      if (!repo.ok) {
        return { ok: false, error: repo.message, stdout: '', stderr: '' }
      }
      const recipe = (loadHooks(repo.repo.path)?.vmRecipes ?? []).find(
        (entry) => entry.id === args.recipeId
      )
      if (!recipe) {
        return { ok: false, error: `Recipe not found: ${args.recipeId}`, stdout: '', stderr: '' }
      }
      const controller = args.provisionId ? new AbortController() : null
      if (args.provisionId && controller) {
        activeProvisionControllers.set(args.provisionId, controller)
      }
      const sendProvisionEvent = (stream: 'stdout' | 'stderr', chunk: string): void => {
        if (!args.provisionId) {
          return
        }
        _event.sender.send('ephemeralVm:provisionEvent', {
          provisionId: args.provisionId,
          stream,
          chunk: redactEphemeralVmRecipeDiagnosticText(chunk)
        })
      }
      const result = await provisionEphemeralVmRuntime({
        userDataPath: app.getPath('userData'),
        repoPath: repo.repo.path,
        repoId: repo.repo.id,
        recipe,
        projectId: args.projectId,
        workspaceId: args.workspaceId,
        workspaceName: args.workspaceName,
        ...(controller ? { signal: controller.signal } : {}),
        onStdout: (chunk) => sendProvisionEvent('stdout', chunk),
        onStderr: (chunk) => sendProvisionEvent('stderr', chunk)
      }).finally(() => {
        if (args.provisionId) {
          activeProvisionControllers.delete(args.provisionId)
        }
      })
      if (!result.ok) {
        return {
          ok: false,
          error: result.start.error,
          stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
          stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
        }
      }
      const connection = getEphemeralVmRecipeResultConnection(result.start.result)
      if (connection.type === 'ssh') {
        try {
          const ssh = await connectRuntimeOwnedSshTarget({
            runtimeId: result.runtime.id,
            connection,
            ...(controller ? { signal: controller.signal } : {})
          })
          const runtime = updateEphemeralVmRuntimeStatus(
            app.getPath('userData'),
            result.runtime.id,
            {
              sshTargetId: ssh.targetId
            }
          )
          return {
            ok: true,
            connectionType: 'ssh',
            runtime,
            sshTargetId: ssh.targetId,
            stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
            warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
          }
        } catch (error) {
          await cleanupEphemeralVmRuntime({
            userDataPath: app.getPath('userData'),
            repoPath: repo.repo.path,
            recipe,
            runtimeId: result.runtime.id
          }).catch(() => undefined)
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
            stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
          }
        }
      }

      let environment: ReturnType<typeof addEnvironmentFromPairingCode>
      try {
        environment = addEnvironmentFromPairingCode(app.getPath('userData'), {
          name: buildEphemeralEnvironmentName(repo.repo.displayName, result.runtime.id),
          pairingCode: connection.pairingCode,
          source: 'ephemeral-vm'
        })
      } catch (error) {
        await cleanupEphemeralVmRuntime({
          userDataPath: app.getPath('userData'),
          repoPath: repo.repo.path,
          recipe,
          runtimeId: result.runtime.id
        }).catch(() => undefined)
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
          stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
        }
      }
      const runtime = updateEphemeralVmRuntimeStatus(app.getPath('userData'), result.runtime.id, {
        runtimeEnvironmentId: environment.id
      })
      return {
        ok: true,
        connectionType: 'orca-server',
        runtime,
        environment: redactRuntimeEnvironment(environment),
        stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
        warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
      }
    }
  )

  ipcMain.handle(
    'ephemeralVm:cancelProvision',
    (_event, args: { provisionId: string }): { cancelled: boolean } => {
      const controller = activeProvisionControllers.get(args.provisionId)
      if (!controller) {
        return { cancelled: false }
      }
      controller.abort()
      activeProvisionControllers.delete(args.provisionId)
      return { cancelled: true }
    }
  )
}

function buildEphemeralEnvironmentName(repoName: string, runtimeId: string): string {
  return `${repoName} VM ${runtimeId.slice(-8)}`
}
