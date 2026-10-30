import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { OMP_SESSION_OPTION_CATALOG } from '../../../shared/agent-session-option-catalog-omp'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../../shared/structured-agent-session-options'
import { recordedOmpOptions } from '../../acp/acp-thinking-options.test-fixture'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogSource
} from '../agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogFilePersistence } from '../agent-model-catalog/agent-model-catalog-persistence'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import { agentModelCatalogFingerprintForRecord } from '../agent-model-catalog/agent-model-catalog-fingerprint'
import {
  hostTestRestingOptionsRecord as restingRecord,
  hostTestRestingOptionsJournal as restingJournal,
  hostTestOptionsReadStore
} from './structured-agent-session-host-test-data'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'

const SESSION = 'session-1'

it.each(
  (['discovery', 'live'] as const).flatMap((source) => [
    { source, knownFirst: undefined, efforts: undefined },
    ...[true, false].flatMap((knownFirst) =>
      [
        [],
        [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      ].map((efforts) => ({ source, knownFirst, efforts }))
    )
  ])
)(
  'reloads $source OMP evidence (knownFirst=$knownFirst, menu=$efforts) through the resting picker',
  async ({ source, knownFirst, efforts }) => {
    const directory = await mkdtemp(join(tmpdir(), 'pr36158-menu-'))
    const expected = efforts ?? [
      { value: 'off', label: 'Off' },
      { value: 'auto', label: 'Auto', description: 'Auto-detect per prompt' }
    ]
    try {
      let at = 1
      const store = new AgentModelCatalogStore({ now: () => at++ })
      await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
      const record = { ...restingRecord(), provider: 'omp', options: { model: 'target' } }
      const fingerprint = agentModelCatalogFingerprintForRecord(record)
      const { models } = recordedOmpOptions('loaded').read()
      const known = models.map((model) =>
        model.id === 'target'
          ? { id: model.id, label: model.label, isDefault: false, efforts: expected }
          : model
      )
      const other = source === 'live' ? 'discovery' : 'live'
      const order: AgentModelCatalogSource[] =
        knownFirst === undefined ? [source] : knownFirst ? [source, other] : [other, source]
      for (const currentSource of order) {
        store.recordSuccess(
          fingerprint,
          'omp',
          {
            origin: currentSource === 'live' ? 'live-session' : 'probe',
            models: knownFirst !== undefined && currentSource === source ? known : models
          },
          currentSource
        )
      }
      await store.flushPersistence()
      const restarted = new AgentModelCatalogStore()
      await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
      const modelCatalog = createAgentModelCatalogService({
        store: restarted,
        ...hostTestOptionsReadStore(() => record),
        drivesRecord: () => true,
        resolveAccountHome: async () => record.accountHome
      })
      const resting = { child: null, params: { provider: 'omp' }, journal: restingJournal() }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read uses only these context members, as in the other options-read fixtures.
      const context = {
        deps: {
          adapter: {},
          agents: NO_STRUCTURED_AGENTS,
          store: hostTestOptionsReadStore(() => record),
          modelCatalog
        },
        serialize: (_id: string, task: () => Promise<unknown>) => task(),
        openConversation: async () => resting,
        conversation: async () => resting
      } as unknown as StructuredAgentSessionMutationContext
      try {
        const answer = await readStructuredAgentSessionOptions(context, SESSION, {
          readsWithoutModel: true
        })
        const target = answer.models.find((model) => model.id === 'target')
        expect(target?.efforts).toEqual(expected)
        if (knownFirst === undefined) {
          expect(target?.effortsKnown).toBe(false)
        } else {
          expect(target).not.toHaveProperty('effortsKnown')
        }
        expect(target).not.toHaveProperty('defaultEffort')
        expect(answer.current.effort).toBeUndefined()
        const state = applyStructuredAgentSessionOptions(
          createStructuredAgentSessionOptionState('omp'),
          OMP_SESSION_OPTION_CATALOG,
          answer
        )
        const effort = structuredAgentSessionOptionSnapshot(state).find(
          (entry) => entry.id === 'effort'
        )
        if (expected.length === 0) {
          expect(effort).toBeUndefined()
        } else {
          expect(effort).toMatchObject({ kind: { type: 'select', choices: expected } })
          expect(effort?.kind).not.toHaveProperty('currentValue')
          expect(effort?.kind).not.toHaveProperty('defaultIsCliDefault')
        }
      } finally {
        modelCatalog.stop()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
