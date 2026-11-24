import type { PipelineRuntime } from '../pipeline-runtime'
import type { PipelineStorePort } from '../pipeline-store-port'
import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  pipelineSourceRevision,
  pipelineReviewCommit,
  runPipelineChecks
} from '../pipeline-evidence'
import { pipelineV2WorkerPorts } from './pipeline-v2-worker-adapter'
import { commandPipelineV2, type PipelineV2Ports } from './pipeline-v2-execution'
import {
  registerPipelineV2InputObserver,
  type PipelineV2InputOwner
} from './pipeline-v2-input-events'
import { getPtyIdForPaneKey } from '../../../ipc/pty/pane/key-state'
import { observePipelineV2RawInput } from './pipeline-v2-session-input'
import { assertPipelineV2FreshTerminal } from './pipeline-v2-fresh-terminal'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { pipelineV2ResponsePorts } from './pipeline-v2-response-ports'

export function pipelineV2RuntimePorts(
  runtime: OrcaRuntimeService,
  assertWorkspace: PipelineRuntime['assertWorkspace'],
  store: PipelineStorePort
): PipelineV2Ports {
  const definitionEnabled = async (run: PipelineV2Run) =>
    (
      await store.templatesV2.getVersion({
        engineVersion: 2,
        projectId: run.workspace.projectId,
        id: run.definition.id,
        version: run.definition.version,
        digest: run.definitionDigest
      })
    ).enabled
  return {
    definitionEnabled,
    ...pipelineV2ResponsePorts(runtime),
    ...pipelineV2WorkerPorts(runtime, undefined, async (request) => {
      const current = await store.getV2(request.runId)
      if (!current.definitionEnabled || !(await definitionEnabled(current))) {
        throw new Error('pipeline_definition_disabled')
      }
      if (
        !request.previousSession &&
        request.executor.surface === 'terminal' &&
        isTuiAgent(request.executor.agent)
      ) {
        assertPipelineV2FreshTerminal(request.executor.agent, runtime.requireStore().getSettings())
      }
    }),
    sourceRevision: async (workspace) => {
      await assertWorkspace(workspace)
      return pipelineSourceRevision(workspace)
    },
    reviewCommit: pipelineReviewCommit,
    checks: async (run, ids) => {
      const result = await runPipelineChecks(
        { workspace: run.workspace, profile: { checks: ids } },
        run.checkSnapshot
      )
      return {
        category:
          result.results.length === ids.length &&
          result.results.every((value) => value.code !== null || value.timedOut)
            ? result.passed
              ? 'passed'
              : 'failed'
            : 'unknown',
        results: result.results,
        body: result.body
      }
    }
  }
}
export async function pumpPipelineV2(service: PipelineRuntime): Promise<void> {
  for (let run of await service.store.pendingV2()) {
    if (!run.activeInvocationId && run.state !== 'running') {
      continue
    }
    try {
      await service.assertWorkspace(run.workspace)
      do {
        const revision = run.revision
        await service.controller.advance(run.id)
        run = await service.store.getV2(run.id)
        if (run.revision === revision || run.activeInvocationId || run.state !== 'running') {
          break
        }
      } while (run.state === 'running')
    } catch {
      await commandPipelineV2(service.store, run.id, {
        kind: 'uncertain',
        reason: 'pipeline_runtime_validation_failed'
      })
    }
  }
}
export function observePipelineV2RuntimeInput(
  runtime: PipelineV2InputOwner,
  service: Pick<PipelineRuntime, 'store'>
): () => void {
  return registerPipelineV2InputObserver(runtime, async (event) => {
    for (const run of await service.store.pendingV2()) {
      const candidate = run.candidates.find(
        (value) => value.id === run.pendingDecision?.candidateId
      )
      const binding = run.invocations.find((value) => value.id === candidate?.invocationId)?.session
      if (
        binding &&
        ((event.handle && binding.terminalHandle === event.handle) ||
          (event.ptyId && binding.paneKey && getPtyIdForPaneKey(binding.paneKey) === event.ptyId))
      ) {
        await observePipelineV2RawInput(service.store, binding, {
          receiptId: event.receiptId,
          accepted: false,
          uncertainDelivery: event.uncertainDelivery,
          queryReply: false,
          submitKeyOnly: event.submitKeyOnly
        })
      }
    }
  })
}
