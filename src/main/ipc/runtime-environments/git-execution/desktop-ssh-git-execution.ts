import { AsyncLocalStorage } from 'node:async_hooks'
import type { KnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  findSshGitExecutionTarget,
  getSshGitExecution
} from '../../../../shared/remote-runtime/ssh/ssh-git-execution'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { RpcDispatcher } from '../../../runtime/rpc/dispatcher'
import { DESKTOP_RPC_CALLER } from '../../../runtime/rpc/callers/rpc-caller-identity'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../desktop-renderer-runtime-capabilities'
import {
  runtimeEnvironmentChangedFailure,
  runtimeEnvironmentRevisionFailure
} from '../requests/runtime-environment-revision-guard'
import {
  createLocalSourceControlRuntime,
  isLocalSourceControlMethod,
  LOCAL_SOURCE_CONTROL_METHODS
} from './local-source-control-runtime'

import {
  createSshGitExecutionCatalog,
  gitExecutionParams,
  isGitExecutionRecord,
  readSshGitResult,
  resolveSshGitExecutionRepo,
  type SshGitExecutionCatalog,
  type SshGitRemoteRead
} from './ssh-git-execution-catalog'

type Catalog = SshGitExecutionCatalog & { dispatcher: RpcDispatcher }

type GitCall = {
  signal?: AbortSignal
  readRemote: SshGitRemoteRead
  metadataWrites: Promise<unknown>[]
}

const activeCall = new AsyncLocalStorage<GitCall>()
const catalogs = new Map<string, Catalog>()
const GITHUB_IMAGE_STAGING_METHODS = new Set([
  'clipboard.startImageUpload',
  'clipboard.appendImageUploadChunk',
  'clipboard.abortImageUpload'
])
let services: { store: Store; runtime: OrcaRuntimeService } | undefined

export function installDesktopSshGitExecution(store: Store, runtime: OrcaRuntimeService): void {
  services = { store, runtime }
  catalogs.clear()
}

function recordRemoteMetadata(method: string, params: unknown): void {
  const call = activeCall.getStore()
  if (call) {
    call.metadataWrites.push(
      call
        .readRemote(method, params)
        .then(readSshGitResult)
        .catch((error: unknown) => {
          console.warn('[local-git-execution] SSH metadata update failed:', error)
        })
    )
  }
}

function catalogFor(environment: KnownRuntimeEnvironment): Catalog {
  if (!services) {
    throw new Error('Desktop Git execution is unavailable')
  }
  const key = JSON.stringify([
    environment.id,
    environment.runtimeId,
    environment.pairingRevision ?? environment.createdAt
  ])
  let catalog = catalogs.get(key)
  if (!catalog) {
    const metadata = createSshGitExecutionCatalog()
    const { repos, worktrees } = metadata
    const facade = createLocalSourceControlRuntime({
      ...services,
      repos,
      worktrees,
      getSignal: () => activeCall.getStore()?.signal,
      gitHost: {
        getAgentSwitchBlocker: async (path) => {
          const worktree = worktrees.find((row) => row.path === path)
          const call = activeCall.getStore()
          if (!worktree || !call) {
            throw new Error('The SSH workspace is unavailable')
          }
          const response = await call.readRemote('git.branchSwitchBlocker', {
            worktree: `id:${worktree.id}`
          })
          if (!response.ok) {
            throw new Error(response.error.message)
          }
          if (response.result !== null && typeof response.result !== 'string') {
            throw new Error('The SSH host could not verify whether an agent is working')
          }
          return response.result
        },
        recordBranchSwitched: (worktree, detached) => {
          recordRemoteMetadata('git.recordBranchSwitched', {
            worktree: `id:${worktree.id}`,
            detached
          })
        },
        persistMaterializedPushTarget: (worktree, pushTarget) => {
          recordRemoteMetadata('worktree.set', { worktree: `id:${worktree.id}`, pushTarget })
        }
      },
      onMutation: async () => {
        await Promise.all(activeCall.getStore()?.metadataWrites ?? [])
        catalog?.refreshedAt.clear()
      }
    })
    catalog = {
      ...metadata,
      dispatcher: new RpcDispatcher({ runtime: facade, methods: LOCAL_SOURCE_CONTROL_METHODS })
    }
    catalogs.set(key, catalog)
  }
  return catalog
}

/** Only the desktop's saved SSH policy can authorize access to its mounted checkout. */
export async function routeDesktopSshGitExecution(args: {
  environment: KnownRuntimeEnvironment
  method: string
  params: unknown
  readRemote: SshGitRemoteRead
  signal?: AbortSignal
  expectedPairingRevision?: number
  expectedRuntimeId?: string
  getCurrentEnvironment?: () => Promise<KnownRuntimeEnvironment>
  isCurrent?: () => boolean
}): Promise<RuntimeRpcResponse<unknown> | null> {
  const requestParams = gitExecutionParams(args.params)
  const imageStaging =
    GITHUB_IMAGE_STAGING_METHODS.has(args.method) &&
    isGitExecutionRecord(requestParams.gitExecutionTarget)
  if (!services || (!isLocalSourceControlMethod(args.method) && !imageStaging)) {
    return null
  }
  const target = findSshGitExecutionTarget(
    services.store.getSshTargets(),
    `runtime:${args.environment.id}`,
    [args.environment]
  )
  if (
    !target ||
    (target.gitExecution !== 'local' &&
      !Object.values(target.gitExecutionProjects ?? {}).includes('local'))
  ) {
    return null
  }
  const revisionFailure = runtimeEnvironmentRevisionFailure(
    args.environment,
    args.expectedPairingRevision,
    args.method,
    args.expectedRuntimeId
  )
  if (revisionFailure) {
    return revisionFailure
  }
  const catalog = catalogFor(args.environment)
  const { repo, params } = await resolveSshGitExecutionRepo(
    catalog,
    args.method,
    requestParams,
    args.readRemote
  )
  if (getSshGitExecution(target, repo?.path ?? '') !== 'local') {
    return null
  }
  args.signal?.throwIfAborted()
  const currentEnvironment = args.getCurrentEnvironment
    ? await args.getCurrentEnvironment()
    : args.environment
  const currentRevisionFailure = runtimeEnvironmentRevisionFailure(
    currentEnvironment,
    args.environment.pairingRevision ?? args.environment.createdAt,
    args.method,
    args.environment.runtimeId ?? undefined
  )
  if (currentRevisionFailure) {
    return currentRevisionFailure
  }
  if (!currentEnvironment.runtimeId) {
    return runtimeEnvironmentChangedFailure(currentEnvironment, args.method)
  }
  if (args.isCurrent?.() === false) {
    const error = new Error('The SSH request was superseded')
    error.name = 'AbortError'
    throw error
  }
  args.signal?.throwIfAborted()
  const latestTarget = findSshGitExecutionTarget(
    services.store.getSshTargets(),
    `runtime:${args.environment.id}`,
    [currentEnvironment]
  )
  if (!latestTarget || getSshGitExecution(latestTarget, repo?.path ?? '') !== 'local') {
    return null
  }
  delete params.expectedGhAccount
  const response = await activeCall.run({ ...args, metadataWrites: [] }, async () => {
    try {
      return await catalog.dispatcher.dispatch(
        { id: args.method, authToken: 'desktop-ipc', method: args.method, params },
        {
          caller: DESKTOP_RPC_CALLER,
          clientId: 'desktop-renderer',
          clientKind: 'runtime',
          signal: args.signal,
          clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
        }
      )
    } finally {
      await Promise.all(activeCall.getStore()?.metadataWrites ?? [])
    }
  })
  return {
    ...response,
    _meta: { runtimeId: currentEnvironment.runtimeId }
  }
}
