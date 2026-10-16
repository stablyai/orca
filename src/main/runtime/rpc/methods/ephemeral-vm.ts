import type { z } from 'zod'
import type { WorktreeCreate } from '../../../../shared/rpc-contract/worktree-create-params'
import {
  getEphemeralVmRecipeResultProjectRoot,
  getEphemeralVmRecipeResultCheckoutMode
} from '../../../../shared/ephemeral-vm-recipes'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { getAppEnvironment } from '../../../../shared/app-environment'
import {
  runEphemeralVmProvisionRequest,
  cancelEphemeralVmProvisionRequest
} from '../../ephemeral-vm-provision-requests'
import { getEphemeralVmHost } from '../../ephemeral-vm-host-registry'
import { defineMethod, defineStreamingMethod } from '../core'
import {
  EphemeralVmAdopt,
  EphemeralVmProvisionWorkspace,
  EphemeralVmRepo,
  EphemeralVmRecipe,
  EphemeralVmProvision,
  EphemeralVmProvisionId,
  EphemeralVmRuntime,
  EphemeralVmWorkspace,
  EphemeralVmAttach
} from '../../../../shared/rpc-contract/ephemeral-vm-params'

function adoptionFields(params: z.infer<typeof WorktreeCreate>) {
  return {
    ...params,
    parentWorkspace: undefined,
    linkedIssue: params.linkedIssue ?? undefined,
    linkedPR: params.linkedPR ?? undefined,
    linkedGitLabMR: params.linkedGitLabMR ?? undefined,
    linkedGitLabIssue: params.linkedGitLabIssue ?? undefined
  }
}

let subscriptionSequence = 0

export const EPHEMERAL_VM_METHODS = [
  defineMethod({
    name: 'ephemeralVm.adoptProvisionedRoot',
    permission: 'host-admin',
    params: EphemeralVmAdopt,
    handler: async (params, { runtime }) => {
      const result = await getEphemeralVmHost().adoptProvisionedRoot({
        ...adoptionFields(params),
        repoId: params.repoId,
        name: params.name,
        runtimeId: params.runtimeId,
        expectedPath: params.expectedPath,
        expectedRefHead: params.expectedRefHead,
        executionHostId: 'local'
      })
      runtime.invalidateWorktreeCatalog(params.repoId)
      return result
    }
  }),
  defineMethod({
    name: 'ephemeralVm.provisionWorkspace',
    permission: 'host-admin',
    params: EphemeralVmProvisionWorkspace,
    handler: (params, { runtime }) =>
      runEphemeralVmProvisionRequest(
        getAppEnvironment().getPath('userData'),
        params,
        async (signal) => {
          const host = getEphemeralVmHost()
          const result = await host.provision(params)
          if (!result.ok) {
            return result
          }
          let setupId: string | undefined
          try {
            signal.throwIfAborted()
            if (
              result.connectionType !== 'ssh' ||
              getEphemeralVmRecipeResultCheckoutMode(result.runtime.recipeResult) !==
                'provisioned-root'
            ) {
              throw new Error(
                'Server-owned workspace creation requires a provisioned-root SSH recipe.'
              )
            }
            const setup = await runtime.setupProjectExistingFolder({
              projectId: params.projectId,
              hostId: toSshExecutionHostId(result.sshTargetId),
              path: getEphemeralVmRecipeResultProjectRoot(result.runtime.recipeResult),
              setupMethod: 'imported-existing-folder'
            })
            setupId = setup.setup.id
            signal.throwIfAborted()
            await host.adoptProvisionedRoot({
              ...adoptionFields(params.workspaceRequest),
              name: params.workspaceName,
              repoId: setup.repo.id,
              runtimeId: result.runtime.id,
              executionHostId: toSshExecutionHostId(result.sshTargetId),
              expectedPath: setup.repo.path,
              ...(params.branch ? { branchNameOverride: params.branch } : {}),
              ...(result.expectedRefHead ? { expectedRefHead: result.expectedRefHead } : {})
            })
            signal.throwIfAborted()
            runtime.invalidateWorktreeCatalog(setup.repo.id)
            return result
          } catch (error) {
            const cleaned = await Promise.resolve(
              host.cleanup({ runtimeId: result.runtime.id })
            ).catch(() => undefined)
            if (cleaned?.cleanupStatus === 'succeeded' && setupId) {
              runtime.deleteProjectHostSetup({ setupId })
            }
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              stderr: result.stderr,
              stdout: ''
            }
          }
        }
      )
  }),
  defineStreamingMethod({
    name: 'ephemeralVm.provisionEvents',
    permission: 'host-admin',
    params: EphemeralVmProvisionId,
    handler: async ({ provisionId }, { runtime, connectionId, signal }, emit) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = getEphemeralVmHost().onProvisionEvent((event) => {
          if (event.provisionId === provisionId) {
            emit(event)
          }
        })
        const subscriptionId = `ephemeral-vm-${connectionId ?? 'inproc'}-${++subscriptionSequence}`
        const close = () => {
          unsubscribe()
          resolve()
        }
        runtime.registerSubscriptionCleanup(subscriptionId, close, connectionId)
        signal?.addEventListener('abort', () => runtime.cleanupSubscription(subscriptionId), {
          once: true
        })
        if (signal?.aborted) {
          runtime.cleanupSubscription(subscriptionId)
        } else {
          emit({ type: 'ready', subscriptionId })
        }
      })
    }
  }),
  defineMethod({
    name: 'ephemeralVm.listRecipes',
    permission: 'host-admin',
    params: EphemeralVmRepo,
    handler: (params) => getEphemeralVmHost().listRecipes(params)
  }),
  defineMethod({
    name: 'ephemeralVm.listRecipeCatalog',
    permission: 'host-admin',
    params: null,
    handler: () => getEphemeralVmHost().listRecipeCatalog()
  }),
  defineMethod({
    name: 'ephemeralVm.doctor',
    permission: 'host-admin',
    params: EphemeralVmRecipe,
    handler: (params) => getEphemeralVmHost().doctor(params)
  }),
  defineMethod({
    name: 'ephemeralVm.provision',
    permission: 'host-admin',
    params: EphemeralVmProvision,
    handler: (params) =>
      runEphemeralVmProvisionRequest(getAppEnvironment().getPath('userData'), params, async () =>
        getEphemeralVmHost().provision(params)
      )
  }),
  defineMethod({
    name: 'ephemeralVm.cancelProvision',
    permission: 'host-admin',
    params: EphemeralVmProvisionId,
    handler: async (params) => {
      const cancelled = cancelEphemeralVmProvisionRequest(
        getAppEnvironment().getPath('userData'),
        params.provisionId
      )
      const provider = await getEphemeralVmHost().cancelProvision(params)
      return { cancelled: cancelled || provider.cancelled }
    }
  }),
  defineMethod({
    name: 'ephemeralVm.listRuntimes',
    permission: 'host-admin',
    params: null,
    handler: () => getEphemeralVmHost().listRuntimes()
  }),
  defineMethod({
    name: 'ephemeralVm.attachWorkspace',
    permission: 'host-admin',
    params: EphemeralVmAttach,
    handler: (params) => getEphemeralVmHost().attachWorkspace(params)
  }),
  defineMethod({
    name: 'ephemeralVm.cleanup',
    permission: 'host-admin',
    params: EphemeralVmRuntime,
    handler: (params) => getEphemeralVmHost().cleanup(params)
  }),
  defineMethod({
    name: 'ephemeralVm.stopCleanup',
    permission: 'host-admin',
    params: EphemeralVmRuntime,
    handler: (params) => getEphemeralVmHost().stopCleanup(params)
  }),
  defineMethod({
    name: 'ephemeralVm.suspendWorkspace',
    permission: 'host-admin',
    params: EphemeralVmWorkspace,
    handler: (params) => getEphemeralVmHost().suspendWorkspace(params)
  }),
  defineMethod({
    name: 'ephemeralVm.resumeWorkspace',
    permission: 'host-admin',
    params: EphemeralVmWorkspace,
    handler: (params) => getEphemeralVmHost().resumeWorkspace(params)
  }),
  defineMethod({
    name: 'ephemeralVm.getCleanupCommand',
    permission: 'host-admin',
    params: EphemeralVmRuntime,
    handler: (params) => getEphemeralVmHost().getCleanupCommand(params)
  })
] as const
