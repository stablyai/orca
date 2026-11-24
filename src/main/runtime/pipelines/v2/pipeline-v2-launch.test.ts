import { expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import { pipelineV2AgentStage } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { PipelineV2AgentExecutor } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { resolvePipelineV2Launch } from './pipeline-v2-launch'
import {
  assertPipelineV2SessionCompatible,
  readPipelineV2TerminalOptions
} from './pipeline-v2-session-compatibility'
import { resolveWorkerStartModeOnHost } from '../../rpc/methods/orchestration/structured-workers/orchestration-worker-start-mode'

const models: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: true,
  models: [
    {
      id: 'fixture-model-a',
      label: 'Fixture A',
      isDefault: true,
      defaultEffort: 'high',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    },
    {
      id: 'fixture-model-b',
      label: 'Fixture B',
      isDefault: false,
      defaultEffort: 'low',
      efforts: [{ value: 'low', label: 'Low' }]
    }
  ]
}
const workspace = { id: 'repo::/project', path: '/project' }
function environment(catalog = models) {
  return {
    settings: {
      agentLaunchChoices: { codex: { model: 'fixture-model-a', options: { effort: 'high' } } },
      agentPermissionDefault: 'own' as const
    },
    catalog: async () => catalog,
    chatSupport: async () => ({ supported: true })
  }
}
it('pins_concrete_defaults_and_does_not_change_them_when_defaults_change', async () => {
  const stage = pipelineV2AgentStage('plan')
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent stage')
  }
  stage.executor.model = { kind: 'default' }
  delete stage.executor.effort
  const host = environment()
  const effective = await resolvePipelineV2Launch(host, stage, workspace)
  host.settings.agentLaunchChoices.codex.model = 'fixture-model-b'
  expect(effective).toMatchObject({
    model: 'fixture-model-a',
    effort: 'high',
    permissionMode: 'own',
    surface: 'chat'
  })
})
it('unavailable_model_fails_without_fallback', async () => {
  const stage = pipelineV2AgentStage('plan')
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent stage')
  }
  stage.executor.model = { kind: 'explicit', id: 'unavailable-model' }
  await expect(resolvePipelineV2Launch(environment(), stage, workspace)).rejects.toThrow(
    'pipeline_model_unavailable'
  )
})
it('unknown_default_and_unsupported_effort_fail_before_launch', async () => {
  const stage = pipelineV2AgentStage('plan')
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent stage')
  }
  const host = environment({ origin: 'unknown' })
  stage.executor.model = { kind: 'default' }
  await expect(resolvePipelineV2Launch(host, stage, workspace)).rejects.toThrow(
    'pipeline_model_unavailable'
  )
  stage.executor.model = { kind: 'explicit', id: 'fixture-model-b' }
  await expect(resolvePipelineV2Launch(environment(), stage, workspace)).rejects.toThrow(
    'pipeline_effort_unavailable'
  )
})
it('explicit_chat_surface_is_never_downgraded_to_terminal', async () => {
  const stage = pipelineV2AgentStage('plan')
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent stage')
  }
  const host = { ...environment(), chatSupport: async () => ({ supported: false }) }
  await expect(resolvePipelineV2Launch(host, stage, workspace)).rejects.toThrow(
    'pipeline_surface_unavailable'
  )
})
it.each([
  ['codex', 'terminal', 'accept-edits'],
  ['opencode', 'chat', 'auto'],
  ['grok', 'chat', 'accept-edits']
] as const)(
  'refuses %s %s permission %s before admission',
  async (agent, surface, permissionMode) => {
    const stage = pipelineV2AgentStage('plan')
    if (stage.kind !== 'agent') {
      throw new Error('Expected agent stage')
    }
    stage.executor = { ...stage.executor, agent, surface, permissionMode }
    await expect(resolvePipelineV2Launch(environment(), stage, workspace)).rejects.toThrow(
      'pipeline_permission_mode_unsupported'
    )
  }
)
it('refuses automatic approval when the selected model explicitly does not support it', async () => {
  const stage = pipelineV2AgentStage('plan')
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent stage')
  }
  stage.executor = { ...stage.executor, agent: 'claude', permissionMode: 'auto' }
  const host = environment({
    ...models,
    models: models.models.map((row) => ({ ...row, supportsAutoMode: false }))
  })
  await expect(resolvePipelineV2Launch(host, stage, workspace)).rejects.toThrow(
    'pipeline_permission_mode_unsupported'
  )
})
it('refuses terminal permission policies whose live mode cannot be attested for pipeline continuation', async () => {
  const stage = pipelineV2AgentStage('plan')
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent stage')
  }
  stage.executor.surface = 'terminal'
  stage.executor.permissionMode = 'ask'
  await expect(resolvePipelineV2Launch(environment(), stage, workspace)).rejects.toThrow(
    'pipeline_permission_mode_unsupported'
  )
})
it('refuses a terminal model which the native launch transport cannot apply', async () => {
  const stage = pipelineV2AgentStage('plan')
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent stage')
  }
  stage.executor = { ...stage.executor, agent: 'gemini', surface: 'terminal', effort: undefined }
  await expect(resolvePipelineV2Launch(environment(), stage, workspace)).rejects.toThrow(
    'pipeline_model_transport_unavailable'
  )
})
it.each(['resume --last', 'fork saved-session', '--resume=saved-session'])(
  'refuses inherited session selectors %s for a fresh terminal',
  async (agentArgs) => {
    const stage = pipelineV2AgentStage('plan')
    if (stage.kind !== 'agent') {
      throw new Error('Expected agent stage')
    }
    stage.executor.surface = 'terminal'
    const host = environment()
    await expect(
      resolvePipelineV2Launch(
        { ...host, settings: { ...host.settings, agentDefaultArgs: { codex: agentArgs } } },
        stage,
        workspace
      )
    ).rejects.toThrow('pipeline_fresh_session_required')
  }
)
it('refuses a session selector in the configured terminal command before admission', async () => {
  const stage = pipelineV2AgentStage('plan')
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent stage')
  }
  stage.executor.surface = 'terminal'
  const host = environment()
  const settings = { ...host.settings, agentCmdOverrides: { codex: 'codex resume --last' } }
  await expect(resolvePipelineV2Launch({ ...host, settings }, stage, workspace)).rejects.toThrow(
    'pipeline_fresh_session_required'
  )
})
it('detects_model_and_effort_drift_from_the_bound_terminal_frame', () => {
  const actual = readPipelineV2TerminalOptions(
    {
      source: 'screen',
      tail: ['Plan ready', '› Ask anything', '  Fixture B low · ~/project · Idle']
    },
    models
  )
  expect(actual).toEqual({ model: 'fixture-model-b', effort: 'low' })
  expect(() =>
    assertPipelineV2SessionCompatible(
      {
        agent: 'codex',
        model: 'fixture-model-a',
        effort: 'high',
        surface: 'terminal',
        permissionMode: 'own',
        compatibilityKey: 'a'.repeat(64)
      },
      { agent: 'codex', surface: 'terminal', permissionMode: 'own', ...actual }
    )
  ).toThrow('pipeline_session_executor_changed')
})
it('stream_output_and_unknown_or_ambiguous_models_cannot_certify_reuse', () => {
  expect(() =>
    readPipelineV2TerminalOptions(
      { source: 'stream', tail: ['Fixture A high · ~/project'] },
      models
    )
  ).toThrow('pipeline_session_options_unverifiable')
  expect(() =>
    readPipelineV2TerminalOptions(
      { source: 'screen', tail: ['Unlisted model high · ~/project'] },
      models
    )
  ).toThrow('pipeline_session_options_unverifiable')
})
it('existing_chat_dispatch_does_not_require_new_chat_launch_support', async () => {
  const mode = {
    mode: 'structured' as const,
    preferred: 'structured' as const,
    reason: 'requested' as const,
    detail: 'Reuse the bound chat'
  }
  expect(
    await resolveWorkerStartModeOnHost(
      {
        getStructuredAgentSessionCreateSupport: async () => ({
          supported: false,
          reason: 'agent' as const
        })
      },
      mode,
      workspace.id,
      undefined,
      true
    )
  ).toEqual(mode)
})
it('effort_values_come_from_the_selected_surface_catalog', async () => {
  const stage = pipelineV2AgentStage('plan')
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent model fixture')
  }
  stage.executor = PipelineV2AgentExecutor.parse({ ...stage.executor, effort: 'deep-chat' })
  const host = environment({
    ...models,
    models: models.models.map((row) => ({
      ...row,
      chatEfforts: [{ value: 'deep-chat', label: 'Deep chat' }]
    }))
  })
  expect(await resolvePipelineV2Launch(host, stage, workspace)).toMatchObject({
    effort: 'deep-chat',
    surface: 'chat'
  })
  stage.executor.surface = 'terminal'
  await expect(resolvePipelineV2Launch(host, stage, workspace)).rejects.toThrow(
    'pipeline_effort_unavailable'
  )
})
