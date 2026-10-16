import { adoptEphemeralVmProvisionedRoot } from './ephemeral-vm-provisioned-root-host'
import type { EphemeralVmHost } from '../runtime/ephemeral-vm-host-registry'
import { getAppEnvironment } from '../../shared/app-environment'
import type { Store } from '../persistence'
import type { EphemeralVmApi } from '../../shared/ephemeral-vm-api'
import {
  getEphemeralVmRecipeResultConnection,
  type EphemeralVmRecipeDoctorResult
} from '../../shared/ephemeral-vm-recipes'
import {
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  type EphemeralVmRecipeResultWarning
} from '../../shared/ephemeral-vm-recipe-diagnostics'
import { getProvisionedRootRecipeRepoUrl } from '../../shared/ephemeral-vm-recipe-repo-url'
// Why: import directly from the doctor module (not the barrel) — it uses Node
// fs/path and must stay out of the browser bundle that imports the barrel.
import { doctorEphemeralVmRecipe } from '../../shared/ephemeral-vm-recipe-doctor'
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
  resolveRecipeForRepo,
  type EphemeralVmRecipeCatalogEntry
} from './ephemeral-vm-recipe-context'
import { createEphemeralVmRuntimeHost } from './ephemeral-vm-runtime-host'
import type { PluginService } from '../plugins/plugin-service'
import { getApprovedPluginVmRecipes } from '../plugins/plugin-approved-vm-recipes'
import { resolveProvisionedRootSource } from '../ephemeral-vm-provisioned-root-source'

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
      /** The managed Orca server the host runs; its workspace lives there. */
      environmentId?: string
      expectedRefHead?: string
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: false
      error: string
      stderr: string
      stdout: string
    }

const hosts = new WeakMap<Store, { host: EphemeralVmHost; pluginService?: PluginService }>()

export function createEphemeralVmHost(
  store: Store,
  pluginService?: PluginService,
  getUserDataPath: () => string = () => getAppEnvironment().getPath('userData')
): EphemeralVmHost {
  const existing = hosts.get(store)
  if (existing) {
    existing.pluginService = pluginService ?? existing.pluginService
    return existing.host
  }
  const approvedPlugins = () =>
    getApprovedPluginVmRecipes(hosts.get(store)?.pluginService ?? pluginService)
  const activeProvisionControllers = new Map<string, AbortController>()
  const listeners = new Set<Parameters<EphemeralVmApi['onProvisionEvent']>[0]>()
  const host = {
    ...createEphemeralVmRuntimeHost(store, getUserDataPath),
    adoptProvisionedRoot: (args) => adoptEphemeralVmProvisionedRoot(store, getUserDataPath, args),
    onProvisionEvent(listener: Parameters<EphemeralVmApi['onProvisionEvent']>[0]) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    listRecipes: async (args: { repoId: string }) => {
      return listRecipes(store, args.repoId, await approvedPlugins())
    },

    listRecipeCatalog: async (): Promise<EphemeralVmRecipeCatalogEntry[]> => {
      return listRecipeCatalog(store, await approvedPlugins())
    },

    doctor: async (args: {
      repoId: string
      recipeId: string
    }): Promise<EphemeralVmRecipeDoctorResult> => {
      const repo = getRecipeRepo(store, args.repoId)
      if (!repo.ok) {
        return repo.doctor(args.recipeId)
      }
      const pluginRecipes = await approvedPlugins()
      return doctorEphemeralVmRecipe({
        repoPath: repo.repo.path,
        recipeId: args.recipeId,
        recipes: listRecipes(store, args.repoId, pluginRecipes).recipes,
        localExecutionSupported: true
      })
    },

    provision: async (args: {
      repoId: string
      recipeId: string
      workspaceName?: string
      projectId?: string
      workspaceId?: string
      branch?: string
      ref?: string
      provisionId?: string
    }): Promise<EphemeralVmProvisionIpcResult> => {
      const repo = getRecipeRepo(store, args.repoId)
      if (!repo.ok) {
        return { ok: false, error: repo.message, stdout: '', stderr: '' }
      }
      const recipe = resolveRecipeForRepo(repo.repo.path, args.recipeId, await approvedPlugins())
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
        for (const listener of listeners) {
          listener({
            provisionId: args.provisionId,
            stream,
            chunk: redactEphemeralVmRecipeDiagnosticText(chunk)
          })
        }
      }
      // Why: deregister only when the whole handler settles, so cancelProvision still finds the
      // controller for every phase that reads its signal.
      try {
        let recipeRepoUrl = repo.repo.gitRemoteIdentity?.remoteUrl
        let sourceRef = args.ref
        let expectedRefHead: string | undefined
        if (recipe.checkoutMode === 'provisioned-root') {
          const source = await resolveProvisionedRootSource(
            store,
            repo.repo,
            args.ref,
            controller?.signal
          )
          if (controller?.signal.aborted) {
            return { ok: false, error: 'Provisioning cancelled.', stdout: '', stderr: '' }
          }
          if (!source) {
            return {
              ok: false,
              error: args.ref
                ? `Could not resolve provisioned-root start ref: ${args.ref}`
                : 'Could not resolve a default provisioned-root start ref.',
              stdout: '',
              stderr: ''
            }
          }
          sourceRef = source.ref
          expectedRefHead = source.head
          recipeRepoUrl = source.remoteUrl ?? recipeRepoUrl
        }
        const repoUrl = getProvisionedRootRecipeRepoUrl(recipe.checkoutMode, recipeRepoUrl)
        const result = await provisionEphemeralVmRuntime({
          userDataPath: getUserDataPath(),
          repoPath: repo.repo.path,
          repoId: repo.repo.id,
          recipe,
          projectId: args.projectId,
          workspaceId: args.workspaceId,
          workspaceName: args.workspaceName,
          ...(repoUrl ? { repoUrl } : {}),
          ...(args.branch ? { branch: args.branch } : {}),
          ...(sourceRef ? { ref: sourceRef } : {}),
          ...(expectedRefHead ? { expectedRefHead } : {}),
          ...(controller ? { signal: controller.signal } : {}),
          onStdout: (chunk) => sendProvisionEvent('stdout', chunk),
          onStderr: (chunk) => sendProvisionEvent('stderr', chunk)
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
              connection
            })
            const runtime = updateEphemeralVmRuntimeStatus(getUserDataPath(), result.runtime.id, {
              sshTargetId: ssh.targetId
            })
            return {
              ok: true,
              connectionType: 'ssh',
              runtime,
              sshTargetId: ssh.targetId,
              ...(expectedRefHead ? { expectedRefHead } : {}),
              stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
              warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
            }
          } catch (error) {
            await cleanupEphemeralVmRuntime({
              userDataPath: getUserDataPath(),
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
          environment = addEnvironmentFromPairingCode(getUserDataPath(), {
            name: buildEphemeralEnvironmentName(repo.repo.displayName, result.runtime.id),
            pairingCode: connection.pairingCode,
            source: 'ephemeral-vm'
          })
        } catch (error) {
          await cleanupEphemeralVmRuntime({
            userDataPath: getUserDataPath(),
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
        const runtime = updateEphemeralVmRuntimeStatus(getUserDataPath(), result.runtime.id, {
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
      } finally {
        if (args.provisionId) {
          activeProvisionControllers.delete(args.provisionId)
        }
      }
    },

    cancelProvision: (args: { provisionId: string }): { cancelled: boolean } => {
      const controller = activeProvisionControllers.get(args.provisionId)
      if (!controller) {
        return { cancelled: false }
      }
      controller.abort()
      activeProvisionControllers.delete(args.provisionId)
      return { cancelled: true }
    }
  }
  hosts.set(store, { host, pluginService })
  return host
}

function buildEphemeralEnvironmentName(repoName: string, runtimeId: string): string {
  return `${repoName} VM ${runtimeId.slice(-8)}`
}
