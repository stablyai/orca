import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PipelineV2Ports, PipelineV2LaunchRequest } from './pipeline-v2-execution'
import type { PipelineSessionBinding } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { startLocalWorker } from '../../rpc/methods/orchestration/worker/start/local-worker-start'
import { resolveDispatchAssigneeParty } from '../../orchestration/addressing/orchestration-party'
import { pipelineWorkerPorts } from '../pipeline-worker-adapter'
import {
  readPipelineV2SessionExecutor,
  type PipelineV2SessionObservation
} from './pipeline-v2-native-launch'
import { assertPipelineV2SessionCompatible } from './pipeline-v2-session-compatibility'
import { isAgentPermissionChoice } from '../../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { toAgentLaunchPreferences } from '../../../../shared/agent-launch/choices/agent-launch-preferences'
import { createWorkerLaunchReceipt } from '../../rpc/methods/orchestration/worker/start/launch/worker-launch-preferences'
import { PipelineV2LaunchRefusedError } from './pipeline-v2-launch-refusal'

export function pipelineV2WorkerPorts(
  runtime: OrcaRuntimeService,
  observeSession: (request: PipelineV2LaunchRequest) => Promise<PipelineV2SessionObservation> = (
    request
  ) => readPipelineV2SessionExecutor(runtime, request),
  assertLaunch: (request: PipelineV2LaunchRequest) => void | Promise<void> = () => {}
): Pick<PipelineV2Ports, 'startInvocation' | 'settled'> {
  const db = runtime.getOrchestrationDb()
  return {
    settled: pipelineWorkerPorts(runtime).settled,
    startInvocation: async (request, spec, prepared) => {
      const executor = request.executor
      const permissionMode = executor.permissionMode === 'default' ? 'own' : executor.permissionMode
      const previous = request.previousSession
      try {
        await assertLaunch(request)
        if (!isTuiAgent(executor.agent) || !isAgentPermissionChoice(permissionMode)) {
          throw new Error('pipeline_permission_mode_unsupported')
        }
        if (previous) {
          assertPipelineV2SessionCompatible(executor, await observeSession(request))
        }
        await assertLaunch(request)
      } catch (error) {
        throw new PipelineV2LaunchRefusedError(error)
      }
      const params = {
        from: '',
        spec,
        worktree: `id:${request.workspace.id}`,
        ...(previous
          ? { terminal: previous.terminalHandle ?? previous.sessionId }
          : {
              agent: executor.agent,
              ...(executor.surface === 'terminal'
                ? { model: executor.model, effort: executor.effort }
                : {})
            })
      }
      const mode = executor.surface === 'chat' ? 'structured' : 'terminal'
      const orchestrationRun = db.createRun({
        objective: `Pipeline ${request.runId}: ${request.stage.id}`,
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      let worker: { dispatchId: string; session: PipelineSessionBinding } | undefined
      const result = await startLocalWorker({
        runtime,
        db,
        params,
        coordinator: null,
        bindRun: () => orchestrationRun,
        taskDeps: undefined,
        mode: {
          mode,
          preferred: mode,
          reason: 'requested',
          detail: `Pipeline requests ${executor.surface}`
        },
        systemCoordinator: {
          workspaceId: request.workspace.id,
          taskOnly: executor.surface === 'chat',
          ...(executor.surface === 'terminal'
            ? {
                decorateTask: (task: string, cli: string) =>
                  `${task}\nRead bounded context with ${cli} pipeline context --api-version 2 --id ${request.runId} --json. ` +
                  `Submit a structured result with ${cli} pipeline submit --api-version 2 --id ${request.runId} --input-file <json-file> before worker_done.`
              }
            : {}),
          requiredMode: mode,
          launchReceipt: previous
            ? undefined
            : createWorkerLaunchReceipt({
                agent: executor.agent,
                model: executor.model,
                effort: executor.effort
              }),
          launchPreferences: previous
            ? undefined
            : executor.surface === 'chat'
              ? {
                  model: executor.model,
                  ...(executor.effort ? { effort: executor.effort } : {}),
                  mode: permissionMode
                }
              : toAgentLaunchPreferences(
                  { model: executor.model, effort: executor.effort, permissionMode },
                  executor.agent
                ),
          prepared: async (value, authority) => {
            await assertLaunch(request)
            const party = resolveDispatchAssigneeParty(value.sessionId, db)
            const session: PipelineSessionBinding = {
              kind: party.orcaSessionId ? 'structured' : 'terminal',
              sessionId: party.orcaSessionId ?? value.sessionId,
              compatibilityKey: executor.compatibilityKey,
              ...(party.terminalHandle ? { terminalHandle: party.terminalHandle } : {}),
              ...(authority.paneKey ? { paneKey: authority.paneKey } : {})
            }
            if ((session.kind === 'structured') !== (executor.surface === 'chat')) {
              throw new Error('pipeline_surface_changed')
            }
            worker = { dispatchId: value.dispatchId, session }
            await prepared(worker)
          }
        }
      })
      const ready =
        result && typeof result === 'object' && 'state' in result && result.state === 'ready'
      const responseMessageId =
        result &&
        typeof result === 'object' &&
        'clientMessageId' in result &&
        typeof result.clientMessageId === 'string'
          ? result.clientMessageId
          : undefined
      return {
        state:
          ready && worker && (executor.surface !== 'chat' || responseMessageId)
            ? 'ready'
            : 'outcome_unknown',
        ...worker,
        ...(responseMessageId ? { responseMessageId } : {})
      }
    }
  }
}
