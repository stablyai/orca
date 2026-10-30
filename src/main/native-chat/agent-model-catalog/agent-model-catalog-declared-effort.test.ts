import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import recordedGrok from '../../acp/fixtures/grok-v1-model.json'
import {
  grokModelCatalogFromState,
  grokModelEfforts
} from '../../acp/acp-dialects/grok-model-catalog'
import { parseOpenCodeModelListing } from '../../opencode/opencode-model-catalog-listing'
import { AcpStructuredOptions } from '../../acp/acp-structured-options'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../../acp/acp-structured-agent-definitions'
import { applyAcpMessageOptions } from '../../acp/acp-message-execution-options'
import type { AcpStructuredSession } from '../../acp/acp-structured-session'
import type { StructuredAgentSessionAdapter } from '../agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentRegistry } from '../agent-session-wire/structured-agent-registry'
import { captureStructuredExecutionOptions } from '../agent-session-wire/structured-agent-session-execution-options'
import { readStructuredAgentSessionOptionsAtRest } from '../agent-session-wire/structured-agent-session-resting-options'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { structuredAgentSessionSeedCatalog } from '../../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionShownSnapshot
} from '../../../shared/structured-agent-session-option-view'
import { firstFrameOptionState } from '../../../renderer/src/components/native-chat/structured-agent-session-option-first-frame'
import { recordHostModelCatalogSnapshot } from '../../../renderer/src/runtime/host-model-catalog-snapshots'
import {
  agentModelCatalogEntry,
  agentModelCatalogEntryWithSuccess,
  agentModelCatalogResultFromEntry,
  entryWithConfiguredDefault
} from './agent-model-catalog-entry'

it('keeps recorded raw declarations out of configured policy, first-frame capture, host defaults and ACP setters', async () => {
  for (const [agent, reported, policy, display] of [
    ['grok', 'low', 'high', 'low'],
    ['grok', 'max', 'high', null],
    ['opencode', '', 'low', null]
  ] as const) {
    const raw = { ...recordedGrok, _meta: { ...recordedGrok._meta, reasoningEffort: reported } }
    const models =
      agent === 'grok'
        ? grokModelCatalogFromState({ currentModelId: raw.modelId, availableModels: [raw] })
        : parseOpenCodeModelListing(
            readFileSync(
              new URL('../../acp/fixtures/opencode-v1-model-listing.txt', import.meta.url),
              'utf8'
            )
          )
    const id = models[0]!.id
    const options = new AcpStructuredOptions({ modelEfforts: grokModelEfforts })
    options.adoptSession(
      {
        models: {
          currentModelId: id,
          availableModels: agent === 'grok' ? [raw] : [{ modelId: id, name: id }]
        },
        ...(reported === 'max'
          ? {
              configOptions: [
                {
                  id: 'effort',
                  name: 'Effort',
                  type: 'select' as const,
                  category: 'thought_level' as const,
                  currentValue: 'max',
                  options: models[0]!.efforts.map((e) => ({ value: e.value, name: e.label }))
                }
              ]
            }
          : {})
      },
      'new'
    )
    const listing = options.startListing()
    expect(listing.configuredDefault).toMatchObject({
      modelId: id,
      effort: reported === 'max' ? 'max' : null
    })
    const live = agentModelCatalogEntry(
      agent,
      'fp',
      null,
      { ...listing, origin: 'live-session', at: 1 },
      null
    )!
    const configured = entryWithConfiguredDefault(live, listing.configuredDefault!, 1)!
    const entry = agentModelCatalogEntryWithSuccess(
      configured,
      { agent, fingerprint: 'fp' },
      { models, origin: 'probe' },
      'discovery',
      2
    )!
    const answer = agentModelCatalogResultFromEntry(entry, true, false)
    expect(entry.models[0]).toMatchObject({ defaultEffort: policy, declaredDefaultEffort: display })
    recordHostModelCatalogSnapshot({ kind: 'local' }, agent, '/folder', answer)
    const first = firstFrameOptionState(
      agent,
      { kind: 'local' },
      { newLaunch: true, seedsModel: false, worktree: '/folder' }
    )
    const selection = structuredAgentSessionMessageSelection(first)
    expect(selection).toEqual({ model: id, effort: policy })
    const spec = acpLaunchSpecFor(agent)!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture/resting readers use registry declarations only; no adapter is invoked.
    const adapter = {
      compact: vi.fn(),
      changeThreadGoal: vi.fn(),
      rewind: vi.fn(),
      recoverRewind: vi.fn()
    } as unknown as StructuredAgentSessionAdapter
    const agents = new StructuredAgentRegistry([
      { definition: acpStructuredAgentDefinition(spec), adapter }
    ])
    const captured = captureStructuredExecutionOptions(
      { agents, agent, persistedOptions: {} },
      undefined,
      selection
    )
    expect(captured).toEqual({ options: { model: id, effort: policy } })
    const set = vi.fn(async (_key: 'model' | 'effort', _value: string) => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: successful setter application reads only spec and the options' appliedInput map.
    const session = { spec, options } as AcpStructuredSession
    if (!('options' in captured)) {
      throw new Error('unexpected refusal')
    }
    expect(await applyAcpMessageOptions(session, captured.options, set, () => true)).toBe(true)
    expect(set.mock.calls).toEqual([
      ['model', id],
      ['effort', policy]
    ])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting reader uses only getConversation and read from these dependencies.
    const restingDeps = {
      agents,
      store: {
        getConversation: () =>
          agentSessionConversationView(agentSessionRecordFixture({ provider: agent, options: {} }))
      },
      modelCatalog: { read: async () => answer }
    } as Parameters<typeof readStructuredAgentSessionOptionsAtRest>[0]
    const rest = await readStructuredAgentSessionOptionsAtRest(restingDeps, 'session', {
      readsWithoutModel: true
    })
    expect(rest.current).toMatchObject({ model: id, effort: policy })
    const seed = structuredAgentSessionSeedCatalog(agent)
    const owned = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState(agent, seed),
      seed,
      {
        models: answer.models,
        listedModelIds: [id],
        current: { model: id, defaulted: [], acceptedInputSources: { model: 'saved' } }
      }
    )
    expect(
      structuredAgentSessionShownSnapshot(owned).find((o) => o.id === 'effort')?.kind.currentValue
    ).toBe(display ?? undefined)
    expect(structuredAgentSessionMessageSelection(owned)).toEqual({ model: id })
    set.mockClear()
    const ownedCapture = captureStructuredExecutionOptions(
      { agents, agent, persistedOptions: {} },
      undefined,
      structuredAgentSessionMessageSelection(owned)
    )
    if (!('options' in ownedCapture)) {
      throw new Error('unexpected refusal')
    }
    await applyAcpMessageOptions(session, ownedCapture.options, set, () => true)
    expect(set.mock.calls).toEqual([['model', id]])
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
