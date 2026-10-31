import { expect, it, vi } from 'vitest'
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
import { structuredAgentSessionSeedCatalog } from '../../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionShownSnapshot
} from '../../../shared/structured-agent-session-option-view'
import {
  agentModelCatalogEntry,
  agentModelCatalogEntryWithSuccess,
  entryWithConfiguredDefault
} from './agent-model-catalog-entry'

it('joins recorded declarations to unchanged configured policy, host capture and ACP setters', async () => {
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
    const seed = structuredAgentSessionSeedCatalog(agent)
    const installed = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState(agent, seed),
      seed,
      catalog,
      { newLaunch: true }
    )
    const selection = structuredAgentSessionMessageSelection(installed)
    expect(selection).toEqual({ model, effort: policy })
    const agents = declaredEffortAgents(agent, declaredEffortReadAdapter(source.options))
    const captured = captureStructuredExecutionOptions(
      { agents, agent, persistedOptions: {} },
      undefined,
      selection
    )
    expect(captured).toEqual({ options: { model, effort: policy } })
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
    expect(set.mock.calls).toEqual([
      ['model', model],
      ['effort', policy]
    ])
    expect(launch.current).toMatchObject({ model, effort: policy })
    expect(live.listedModelIds).toBeUndefined()
    expect(resting.listedModelIds).toContain(model)
    for (const result of [live, resting]) {
      const owned = applyStructuredAgentSessionOptions(
        createStructuredAgentSessionOptionState(agent, seed),
        seed,
        result
      )
      expect(
        structuredAgentSessionShownSnapshot(owned).find((o) => o.id === 'effort')?.kind.currentValue
      ).toBe(display ?? undefined)
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
