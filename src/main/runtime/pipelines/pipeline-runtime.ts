import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import {
  PipelineCheck,
  type PipelineRun,
  type PipelineSelection
} from '../../../shared/pipelines/pipeline-contracts'
import type { Worktree } from '../../../shared/worktree/types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { PipelineStore } from './pipeline-store'
import { bindAdmittedPipeline } from './pipeline-admitted-run'
import { PipelineController } from './pipeline-controller'
import { pipelineWorkerPorts } from './pipeline-worker-adapter'
import {
  pipelineSourceRevision,
  runPipelineChecks,
  pipelineReviewCommit,
  validatePipelineFileEvidence
} from './pipeline-evidence'
import { availablePipelines, resolvePipeline, pipelineProfileHostReady } from './pipeline-profiles'
import { onPipelineProfilesChanged } from './pipeline-profile-events'
import {
  observePipelineV2RuntimeInput,
  pipelineV2RuntimePorts,
  pumpPipelineV2
} from './v2/pipeline-v2-runtime'
import type { PipelineV2Ports } from './v2/pipeline-v2-execution'
import { restorePipelineV2 } from './v2/pipeline-v2-recovery'
import { admitPipelineV2 } from './v2/pipeline-v2-admission'
import { pipelineV2LaunchEnvironment } from './v2/pipeline-v2-native-launch'
import type { Repo } from '../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import { failPipelineSetup, releasePipelineSetup } from './pipeline-setup'
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'

const filePath = () => join(getAppEnvironment().getPath('userData'), 'pipelines', 'runs.sqlite')

export class PipelineRuntime {
  readonly store: PipelineStore
  readonly controller: PipelineController
  readonly v2Ports: PipelineV2Ports
  private readonly stopInput: () => void
  private scheduled = false
  private disposed = false
  private readonly stop: () => void
  private readonly stopProfiles: () => void
  private readonly setupObservers = new Map<string, AbortController>()

  constructor(
    private readonly runtime: OrcaRuntimeService,
    publish?: (event: RuntimeClientEvent) => void
  ) {
    mkdirSync(join(getAppEnvironment().getPath('userData'), 'pipelines'), {
      recursive: true,
      mode: 0o700
    })
    this.store = new PipelineStore(filePath(), publish)
    this.v2Ports = pipelineV2RuntimePorts(
      runtime,
      (workspace) => this.assertWorkspace(workspace),
      this.store
    )
    this.controller = new PipelineController(
      this.store,
      {
        ...pipelineWorkerPorts(runtime),
        sourceRevision: async (workspace) => {
          await this.assertWorkspace(workspace)
          return pipelineSourceRevision(workspace)
        },
        checks: (run) => runPipelineChecks(run, run.checkSnapshot),
        reviewCommit: pipelineReviewCommit,
        validateEvidence: validatePipelineFileEvidence
      },
      this.v2Ports
    )
    this.stopInput = observePipelineV2RuntimeInput(runtime, this)
    this.stop = runtime.getOrchestrationDb().crewChanges.subscribe(() => this.wake())
    this.stopProfiles = onPipelineProfilesChanged(() => this.wake())
    getAppEnvironment().onWillQuit(() => this.dispose())
  }

  async assertWorkspace(workspace: PipelineRun['workspace']): Promise<void> {
    const found = await this.runtime.showManagedWorktree(`id:${workspace.id}`, 'local')
    if (
      !found ||
      found.instanceId !== workspace.instanceId ||
      found.path !== workspace.path ||
      found.repoId !== workspace.projectId ||
      (found.hostId && found.hostId !== 'local')
    ) {
      throw new Error('pipeline_workspace_instance_changed')
    }
  }

  async validateSelection(selection: PipelineSelection, repoId: string) {
    const definition = await resolvePipeline(selection)
    const checks = z.array(PipelineCheck).max(16).parse(this.store.configuredChecks(repoId))
    if (definition.profile.checks.some((id) => !checks.some((check) => check.id === id))) {
      throw new Error('pipeline_project_checks_unconfigured')
    }
    return { definition, checks }
  }

  bind(worktree: Worktree, selection: PipelineSelection, task: string, requestId: string) {
    return bindAdmittedPipeline(this.store, worktree, selection, task, requestId)
  }

  admitV2(selection: unknown, task: string, creationId: string, payload: unknown, repo: Repo) {
    return admitPipelineV2(
      {
        store: this.store,
        launch: pipelineV2LaunchEnvironment(this.runtime),
        project: {
          id: repo.id,
          path: repo.path,
          kind: isFolderRepo(repo) ? 'folder' : 'git',
          hostId: getRepoExecutionHostId(repo)
        }
      },
      selection,
      task,
      creationId,
      payload
    )
  }

  wake(): void {
    if (this.disposed || this.scheduled) {
      return
    }
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) {
        return
      }
      void this.pump().catch((error: unknown) => console.error('[pipelines]', error))
    })
  }

  private async pump(): Promise<void> {
    await pumpPipelineV2(this)
    if (!pipelineProfileHostReady()) {
      return
    }
    const available = await availablePipelines()
    for (let run of this.store.pending()) {
      if (!['running', 'reconciliation_required'].includes(run.state)) {
        continue
      }
      try {
        await this.assertWorkspace(run.workspace)
        if (
          !available.some(
            (row) =>
              row.digest === run.definitionDigest &&
              row.provider.pluginKey === run.provider?.pluginKey &&
              row.provider.fingerprint === run.provider?.fingerprint
          )
        ) {
          if (run.state === 'running') {
            this.store.command(run.id, {
              requestId: `provider-paused:${run.id}:${run.revision}`,
              expectedRevision: run.revision,
              command: {
                kind: 'pause',
                reason:
                  'Profile disabled or changed; restore the exact approved profile before resuming'
              }
            })
          }
          continue
        }
        // Checks have no recoverable live worker after a host restart. An explicit resume reruns them.
        if (run.active?.sessionId === 'runtime-checks') {
          continue
        }
        do {
          const before = run.revision
          await this.controller.advance(run.id)
          run = this.store.get(run.id)
          if (run.revision === before || run.active || run.state !== 'running') {
            break
          }
        } while (!this.disposed)
      } catch (error) {
        run = this.store.get(run.id)
        this.store.command(run.id, {
          requestId: `runtime-stopped:${run.id}:${run.revision}`,
          expectedRevision: run.revision,
          command: { kind: 'uncertain', reason: String(error).slice(0, 500) }
        })
      }
    }
  }

  restore(): void {
    restorePipelineV2(this.store)
    for (const run of this.store.pendingV2()) {
      if (run.setupHold?.terminalHandle) {
        this.observeSetup(run.id, run.setupHold.terminalHandle)
      }
    }
    for (const run of this.store.pending()) {
      if (run.setupHold?.terminalHandle) {
        this.observeSetup(run.id, run.setupHold.terminalHandle)
      }
      if (
        run.active?.sessionId === 'runtime-checks' &&
        this.store.completedCheckEffect(run.active.dispatchId)
      ) {
        this.store.command(run.id, {
          requestId: `interrupted-check:${run.id}:${run.revision}`,
          expectedRevision: run.revision,
          command: { kind: 'interrupted', dispatchId: run.active.dispatchId }
        })
      } else if (
        run.active?.sessionId === 'runtime-checks' &&
        run.state !== 'reconciliation_required'
      ) {
        this.store.command(run.id, {
          requestId: `unknown-check:${run.id}:${run.revision}`,
          expectedRevision: run.revision,
          command: {
            kind: 'uncertain',
            reason: 'Check process outcome unknown after restart; inspect processes before recovery'
          }
        })
      }
    }
    this.wake()
  }

  observeSetup(id: string, terminal: string): void {
    if (this.setupObservers.has(id)) {
      return
    }
    const abort = new AbortController()
    this.setupObservers.set(id, abort)
    const timeout = setTimeout(() => abort.abort(new Error('pipeline_setup_timeout')), 600000)
    void this.runtime
      .waitForSetupTerminalCompletion(terminal, abort.signal)
      .then((completion) => {
        if (completion.exitCode !== 0) {
          throw new Error(`pipeline_setup_failed:${completion.exitCode}`)
        }
        this.releaseSetup(id)
      })
      .catch((error: unknown) => {
        if (this.disposed) {
          return
        }
        failPipelineSetup(this.store, id, String(error).slice(0, 500))
      })
      .finally(() => {
        clearTimeout(timeout)
        this.setupObservers.delete(id)
      })
  }

  releaseSetup(id: string): void {
    if (this.disposed) {
      return
    }
    releasePipelineSetup(this.store, id)
    this.wake()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const observer of this.setupObservers.values()) {
      observer.abort()
    }
    this.stop()
    this.stopProfiles()
    this.stopInput()
    this.store.close()
  }
}

export function restorePipelineRuntime(runtime: OrcaRuntimeService): void {
  // Ordinary startup does not open/create a pipeline database.
  if (hasAppEnvironment() && existsSync(filePath())) {
    queueMicrotask(() => {
      try {
        runtime.pipelineRuntime.restore()
      } catch (error) {
        console.error('[pipelines] Saved runs could not be restored:', error)
      }
    })
  }
}
