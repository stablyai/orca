import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createPipelineOwnerActions } from '../runtime/pipelines/v2/pipeline-v2-owner-actions'
import { ipcMain } from 'electron'
import type { PipelineRuntime } from '../runtime/pipelines/pipeline-runtime'
import { discussPipelineV2BoundSession } from '../runtime/pipelines/v2/pipeline-v2-bound-session'
import { synchronizePipelineV2Session } from '../runtime/pipelines/v2/pipeline-v2-discussion'
import { isTrustedMainRendererSender } from './renderer-requests/main-renderer-sender-trust'
import {
  PipelineV2OwnerInput,
  PipelineV2OwnerSynchronizeInput
} from '../../shared/pipelines/v2/pipeline-v2-owner-contracts'
import type { PipelineOwnerActions } from '../runtime/pipelines/v2/pipeline-v2-owner-actions'
import {
  createPipelineTemplateOwnerActions,
  type PipelineTemplateOwnerActions
} from '../runtime/pipelines/v2/pipeline-v2-template-owner-actions'
import { getRepoExecutionHostId } from '../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import { isWslUncPath } from '../../shared/file-access/wsl-paths'

let trustedId: number | null = null
export function setTrustedPipelineRendererWebContentsId(id: number | null): void {
  trustedId = id
}
export function registerPipelineOwnerHandlers(actions: () => PipelineOwnerActions): void {
  for (const method of ['resolveDecision', 'resolveBudget'] as const) {
    ipcMain.handle(`pipelineOwner:${method}`, async (event, input: unknown) => {
      if (trustedId === null || !isTrustedMainRendererSender(event.sender, trustedId)) {
        throw new Error('pipeline_owner_required')
      }
      return actions()[method](PipelineV2OwnerInput.parse(input))
    })
  }
}
export function registerPipelineSessionHandlers(
  runtime: () =>
    | Pick<PipelineRuntime, 'store' | 'controller' | 'v2Ports' | 'assertWorkspace' | 'wake'>
    | undefined,
  getRuntimeId: () => string
): void {
  ipcMain.handle('pipelineOwner:discussBoundSession', async (event, input: unknown) => {
    if (trustedId === null || !isTrustedMainRendererSender(event.sender, trustedId)) {
      throw new Error('pipeline_owner_required')
    }
    const service = runtime()
    return service
      ? discussPipelineV2BoundSession(service, input)
      : { handled: false, accepted: false }
  })
  ipcMain.handle('pipelineOwner:synchronize', async (event, input: unknown) => {
    if (trustedId === null || !isTrustedMainRendererSender(event.sender, trustedId)) {
      throw new Error('pipeline_owner_required')
    }
    const { expectedRuntimeId, ...request } = PipelineV2OwnerSynchronizeInput.parse(input)
    const assertRuntime = () => {
      if (expectedRuntimeId !== getRuntimeId()) {
        throw new Error('pipeline_runtime_identity_changed')
      }
    }
    assertRuntime()
    const service = runtime()
    if (!service) {
      throw new Error('pipeline_not_found')
    }
    return synchronizePipelineV2Session(
      {
        store: service.store,
        controller: service.controller,
        assertWorkspace: (workspace) => service.assertWorkspace(workspace),
        sourceRevision: service.v2Ports.sourceRevision,
        reviewCommit: service.v2Ports.reviewCommit,
        assertRuntime,
        wake: () => service.wake()
      },
      request
    )
  })
}

export function registerPipelineRuntimeHandlers(runtime: OrcaRuntimeService): void {
  registerPipelineOwnerHandlers(() => {
    const service = runtime.pipelineRuntime
    return createPipelineOwnerActions({
      store: service.store,
      getRuntimeId: () => runtime.getRuntimeId(),
      assertWorkspace: (workspace) => service.assertWorkspace(workspace),
      sourceRevision: service.v2Ports.sourceRevision,
      reviewCommit: service.v2Ports.reviewCommit,
      wake: () => service.wake()
    })
  })
  registerPipelineSessionHandlers(
    () => runtime.peekPipelineRuntime(),
    () => runtime.getRuntimeId()
  )
  registerPipelineTemplateHandlers(() =>
    createPipelineTemplateOwnerActions({
      store: runtime.pipelineRuntime.store,
      assertProject: async (id) => {
        const repo = runtime.requireStore().getRepo(id)
        if (
          !repo ||
          isFolderRepo(repo) ||
          getRepoExecutionHostId(repo) !== 'local' ||
          isWslUncPath(repo.path)
        ) {
          throw new Error('pipeline_local_git_only')
        }
      },
      wake: () => runtime.pipelineRuntime.wake()
    })
  )
}

export function registerPipelineTemplateHandlers(
  actions: () => PipelineTemplateOwnerActions
): void {
  for (const method of ['publishTemplate', 'disableTemplate'] as const) {
    ipcMain.handle(`pipelineOwner:${method}`, async (event, input: unknown) => {
      if (trustedId === null || !isTrustedMainRendererSender(event.sender, trustedId)) {
        throw new Error('pipeline_owner_required')
      }
      return actions()[method](input)
    })
  }
}
