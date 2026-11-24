import type {
  PipelineV2CompiledStage,
  PipelineV2Stage
} from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import type { PipelineV2EffectiveExecutor } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveAgentChoiceLayers } from '../../../../shared/agent-launch/choices/agent-choice-layers'
import { reconcileAgentChoiceArgs } from '../../../../shared/agent-launch/choices/agent-choice-reconciliation'
import {
  isAgentPermissionChoice,
  resolveAgentPermission
} from '../../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { pipelineV2PermissionChoices } from '../../../../shared/pipelines/v2/pipeline-v2-permissions'
import { checkAgentLaunchModelPreferences } from '../../../../shared/agent-launch/choices/agent-launch-model-preferences'
import {
  assertPipelineV2FreshTerminal,
  type PipelineV2LaunchSettings
} from './pipeline-v2-fresh-terminal'

export type PipelineV2LaunchEnvironment = {
  settings: PipelineV2LaunchSettings
  catalog: (agent: string, workspacePath: string) => Promise<AgentSessionModelCatalogResult>
  chatSupport: (
    agent: string,
    workspace: { id: string; path: string }
  ) => Promise<{ supported: boolean }>
  terminalModelSupport?: (
    agent: string,
    model: string,
    workspace: { id: string; path: string }
  ) => Promise<boolean>
}
export async function resolvePipelineV2Launch(
  host: PipelineV2LaunchEnvironment,
  stage: Extract<PipelineV2Stage | PipelineV2CompiledStage, { kind: 'agent' }>,
  workspace: { id: string; path: string }
): Promise<PipelineV2EffectiveExecutor> {
  const { agent, surface } = stage.executor
  if (!isTuiAgent(agent)) {
    throw new Error('pipeline_agent_unavailable')
  }
  if (surface === 'chat' && !(await host.chatSupport(agent, workspace)).supported) {
    throw new Error('pipeline_surface_unavailable')
  }
  if (surface === 'terminal') {
    assertPipelineV2FreshTerminal(agent, host.settings)
  }
  const catalog = await host.catalog(agent, workspace.path)
  if (catalog.origin === 'unknown' || catalog.unavailable) {
    throw new Error('pipeline_model_unavailable')
  }
  const saved = host.settings.agentLaunchChoices?.[agent] ?? {}
  const defaults =
    surface === 'terminal'
      ? reconcileAgentChoiceArgs({
          agent,
          userArgs: host.settings.agentDefaultArgs?.[agent] ?? '',
          choices: saved,
          mode: 'load',
          keys: new Set(['model', 'effort', 'permissionMode'])
        }).choices
      : saved
  const configured = catalog.listingNamesConfiguredModel
    ? catalog.models.find((row) => row.isDefault)
    : undefined
  const choices = resolveAgentChoiceLayers({
    agent,
    argumentOwner: 'defaults',
    defaults: { ...defaults, model: defaults.model ?? configured?.resolvedModel ?? configured?.id },
    explicit: {
      ...(stage.executor.model.kind === 'explicit' ? { model: stage.executor.model.id } : {}),
      ...(stage.executor.effort ? { options: { effort: stage.executor.effort } } : {})
    }
  })
  const row = catalog.models.find(
    (value) => value.id === choices.model || value.resolvedModel === choices.model
  )
  const model = row?.resolvedModel ?? row?.id
  if (!row || !model || ['default', 'auto'].includes(model)) {
    throw new Error('pipeline_model_unavailable')
  }
  const effort = choices.options?.effort ?? row.defaultEffort
  const efforts = surface === 'chat' ? (row.chatEfforts ?? row.efforts) : row.efforts
  if (effort && !efforts.some((value) => value.value === effort)) {
    throw new Error('pipeline_effort_unavailable')
  }
  const permissionMode =
    stage.executor.permissionMode ?? resolveAgentPermission(agent, host.settings).choice
  if (
    !isAgentPermissionChoice(permissionMode) ||
    !pipelineV2PermissionChoices(agent, surface, row.supportsAutoMode).includes(permissionMode)
  ) {
    throw new Error('pipeline_permission_mode_unsupported')
  }
  if (surface === 'terminal') {
    const checked = checkAgentLaunchModelPreferences({
      agent,
      model,
      effort,
      ...(agent === 'opencode'
        ? {
            openCodeModelLaunchSupported: await host.terminalModelSupport?.(agent, model, workspace)
          }
        : {})
    })
    if ('refusal' in checked) {
      throw new Error('pipeline_model_transport_unavailable')
    }
  }
  const effective = { agent, model, ...(effort ? { effort } : {}), surface, permissionMode }
  return { ...effective, compatibilityKey: pipelineV2Fingerprint(effective) }
}
