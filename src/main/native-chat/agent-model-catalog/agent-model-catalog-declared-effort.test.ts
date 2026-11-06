import { afterEach, expect, it, vi } from 'vitest'
import recordedGrok from '../../acp/fixtures/grok-v1-model.json'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor
} from '../../acp/acp-structured-adapter.test-support'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { AgentSessionOptionRejectedError } from '../agent-session-wire/structured-agent-session-option-error'
import {
  recordedEffortSource,
  recordedEffortCase,
  readRecordedAcpOptions,
  declaredEffortAgents,
  declaredEffortReadAdapter
} from '../../acp/acp-declared-effort.test-fixture'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import { applyAcpMessageOptions } from '../../acp/acp-message-execution-options'
import type { AcpStructuredSession } from '../../acp/acp-structured-session'
import { captureStructuredExecutionOptions } from '../agent-session-wire/structured-agent-session-execution-options'
import { structuredAgentSessionSeedCatalog } from '../../../shared/agent-session/options/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../shared/agent-session/options/structured-agent-session-options'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionShownSnapshot
} from '../../../shared/agent-session/options/structured-agent-session-option-view'
import {
  agentModelCatalogEntry,
  agentModelCatalogEntryWithSuccess,
  entryWithConfiguredDefault
} from './agent-model-catalog-entry'

afterEach(closeProviderTimelineRigs)

it('keeps recorded declarations separate from accepted host input and ACP controls', async () => {
  for (const input of ['low', 'max', 'opencode', 'absent'] as const) {
    const source = recordedEffortSource(input)
    const { agent, model, policy, display, catalog, live, resting, launch } =
      await recordedEffortCase(input)
    expect(source.listing.configuredDefault).toMatchObject({
      modelId: model,
      effort: input === 'max' ? 'max' : null
    })
    expect(source.options.read().current.effort).toBe(input === 'max' ? 'max' : undefined)
    expect(source.catalog.models[0]).toMatchObject({
      defaultEffort: policy,
      ...(input !== 'absent' ? { declaredDefaultEffort: display } : {})
    })
    expect(launch.current.effort).toBeUndefined()
    expect(launch.current.acceptedInputSources).not.toHaveProperty('effort')
    const seed = structuredAgentSessionSeedCatalog(agent)
    const installed = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState(agent, seed),
      seed,
      catalog,
      { newLaunch: true }
    )
    expect(
      structuredAgentSessionShownSnapshot(installed).find((o) => o.id === 'effort')?.kind
        .currentValue
    ).toBe(display ?? undefined)
    const selection = structuredAgentSessionMessageSelection(installed)
    expect(selection).toEqual({})
    const agents = declaredEffortAgents(agent, declaredEffortReadAdapter(source.options))
    const captured = captureStructuredExecutionOptions(
      { agents, agent, persistedOptions: {} },
      undefined,
      selection
    )
    expect(captured).toEqual({ options: {} })
    const unused = (): never => {
      throw new Error('setter contract accessed an unrelated session port')
    }
    const session: AcpStructuredSession = {
      spec: acpLaunchSpecFor(agent)!,
      options: source.options,
      sessionId: 'setter-contract',
      fence: 1,
      acquisitionGeneration: 'test',
      get connection() {
        return unused()
      },
      get lane() {
        return unused()
      },
      get prompts() {
        return unused()
      },
      get turns() {
        return unused()
      },
      closeRequested: false,
      journalClosed: null,
      ended: false,
      exitObservedAt: null,
      dispose: unused,
      open: unused
    }
    const set = vi.fn(async (_key: 'model' | 'effort', _value: string) => {})
    if (!('options' in captured)) {
      throw new Error('unexpected refusal')
    }
    expect(await applyAcpMessageOptions(session, captured.options, set, () => true)).toBe(true)
    expect(set.mock.calls).toEqual([])
    expect(launch.current).toMatchObject({ model, acceptedInputSources: {} })
    expect(launch.current.effort).toBeUndefined()
    expect(launch.current.acceptedInputSources).not.toHaveProperty('effort')
    expect(live.listedModelIds).toBeUndefined()
    expect(resting.listedModelIds).toContain(model)
    for (const result of [live, resting]) {
      // A readback without this model's effort menu shows no effort, whatever the declaration.
      const shown =
        result.models.find((row) => row.id === model)!.efforts.length > 0 ? display : null
      const owned = applyStructuredAgentSessionOptions(
        createStructuredAgentSessionOptionState(agent, seed),
        seed,
        result
      )
      expect(
        structuredAgentSessionShownSnapshot(owned).find((o) => o.id === 'effort')?.kind.currentValue
      ).toBe(shown ?? undefined)
      expect(structuredAgentSessionMessageSelection(owned)).toEqual({ model })
      set.mockClear()
      const capture = captureStructuredExecutionOptions(
        { agents, agent, persistedOptions: {} },
        undefined,
        structuredAgentSessionMessageSelection(owned)
      )
      if (!('options' in capture)) {
        throw new Error('unexpected refusal')
      }
      await applyAcpMessageOptions(session, capture.options, set, () => true)
      expect(set.mock.calls).toEqual([['model', model]])
    }
    if (input === 'max') {
      const actual = await readRecordedAcpOptions(source.options, agent, source.catalog, {
        model,
        effort: 'max'
      })
      for (const result of [actual.live, actual.resting]) {
        expect(result.current.effort).toBe('max')
        const state = applyStructuredAgentSessionOptions(
          createStructuredAgentSessionOptionState(agent, seed),
          seed,
          result
        )
        expect(structuredAgentSessionMessageSelection(state)).toEqual({ model, effort: 'max' })
      }
    }
  }
})

it('uses fresh configured declarations for every supported source without reviving persisted policy', () => {
  for (const agent of ['claude', 'codex', 'pi', 'omp', 'antigravity']) {
    const models = [
      {
        id: 'model',
        label: 'Model',
        resolvedModel: 'full-model',
        isDefault: false,
        efforts: ['low', 'high'].map((value) => ({ value, label: value }))
      }
    ]
    const restored = agentModelCatalogEntry(agent, 'fp', { models, origin: 'probe', at: 1 }, null, {
      modelId: 'model',
      effort: 'high',
      at: 1
    })!
    expect(restored.models[0]).not.toHaveProperty('declaredDefaultEffort')
    const fresh = ['claude', 'codex', 'pi'].includes(agent)
      ? agentModelCatalogEntryWithSuccess(
          restored,
          { agent, fingerprint: 'fp' },
          {
            models,
            complete: true,
            configured: { model: 'full-model', effort: 'low' },
            origin: 'probe'
          },
          'discovery',
          2
        )!
      : entryWithConfiguredDefault(
          { ...restored, live: { models, origin: 'live-session', at: 2 } },
          { modelId: 'model', effort: 'low' },
          2
        )!
    expect(fresh.models[0]?.declaredDefaultEffort).toBe('low')
  }
})

// The model JSON is recorded; configured effort and control presence vary the regression shape.
it.each([true, false])(
  'leaves unpicked configured model and effort to the agent through the real setter (native control: %s)',
  async (nativeControl) => {
    const source = recordedEffortSource('low')
    const seed = structuredAgentSessionSeedCatalog(source.agent)
    const learned = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState(source.agent, seed),
      seed,
      source.catalog,
      { newLaunch: true }
    )
    const { resting } = await readRecordedAcpOptions(
      source.modelOnly,
      source.agent,
      source.catalog,
      {}
    )
    const rested = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState(source.agent, seed),
      seed,
      resting,
      { newLaunch: true }
    )
    const olderHost = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState(source.agent, seed),
      seed,
      {
        ...resting,
        current: {
          ...resting.current,
          effort: 'high',
          acceptedInputSources: { model: 'policy', effort: 'policy' }
        }
      },
      { newLaunch: true }
    )
    const controls = [
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'low',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' }
        ]
      }
    ]
    const rig = await openAcpAdapterRig({
      script: (agent) => {
        agent.on('session/new', (frame) =>
          agent.reply(frame, {
            sessionId: PROVIDER_SESSION,
            models: {
              currentModelId: source.model,
              availableModels: [
                { ...recordedGrok, _meta: { ...recordedGrok._meta, reasoningEffort: 'low' } }
              ]
            },
            ...(nativeControl ? { configOptions: controls } : {})
          })
        )
        agent.on('session/set_model', (frame) => agent.reply(frame, {}))
        agent.on('session/set_config_option', (frame) =>
          agent.reply(frame, { configOptions: controls })
        )
      }
    })
    await rig.acquire()
    for (const [index, state] of [learned, rested, olderHost].entries()) {
      const selection = structuredAgentSessionMessageSelection(state)
      const captured = captureStructuredExecutionOptions(
        {
          agents: declaredEffortAgents(source.agent, rig.adapter),
          agent: source.agent,
          persistedOptions: {}
        },
        undefined,
        selection
      )
      if (!('options' in captured)) {
        throw new Error('unexpected capture refusal')
      }
      await expect(
        rig.adapter.dispatch({
          sessionId: SESSION,
          fence: 1,
          clientMessageId: `unpicked-${index}`,
          executionOptions: captured.options,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
        })
      ).resolves.toEqual({ state: 'admitted' })
      rig.child().agent.reply(await rig.frame('session/prompt', index), { stopReason: 'end_turn' })
      await waitFor(() => expect(rig.adapter.holdsDispatch(SESSION)).toBe(false))
      // Only an older host's policy answer still names the model as input.
      expect(selection).toEqual(index === 2 ? { model: source.model } : {})
    }
    expect(rig.sent('session/set_config_option')).toEqual([])
    if (!nativeControl) {
      await expect(
        rig.adapter.setOption({ sessionId: SESSION, fence: 1, key: 'effort', value: 'high' })
      ).rejects.toBeInstanceOf(AgentSessionOptionRejectedError)
    }
    await rig.adapter.closeSession(SESSION)
  }
)
