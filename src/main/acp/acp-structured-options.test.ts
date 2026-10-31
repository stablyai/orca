import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AcpStructuredOptions, readAcpLiveOptions } from './acp-structured-options'
import { writeAcpSessionOption } from './acp-session-option-write'
import { grokModelEfforts } from './acp-dialects/grok-model-catalog'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import type { AcpCommandOptionsFixtureModule } from '../../shared/mobile-queued-edit-host.test-fixture-contract'
import { recordedOmpOptions } from './acp-thinking-options.test-fixture'
import { SessionConfigSelectOptionSchema } from './generated/acp-protocol.generated'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogListingKey } from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { OMP_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-omp'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState
} from '../../shared/structured-agent-session-options'

const mobileProducer = { AcpStructuredOptions } satisfies AcpCommandOptionsFixtureModule

const configOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select' as const,
    currentValue: 'model-b',
    options: [
      { value: 'model-a', name: 'Model A' },
      { value: 'model-b', name: 'Model B' }
    ]
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select' as const,
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' }
    ]
  }
]

describe('ACP session options', () => {
  it.each([10, 100])(
    'projects %i live models once while retaining current/report values',
    async (count) => {
      const modelEfforts = vi.fn(grokModelEfforts)
      const options = new mobileProducer.AcpStructuredOptions({ ...GROK_ACP_DIALECT, modelEfforts })
      options.adoptSession({
        configOptions: [
          ...configOptions.slice(1),
          {
            id: 'permission',
            name: 'Permission',
            category: 'mode',
            type: 'select',
            currentValue: 'default',
            options: [{ value: 'default', name: 'Default' }]
          }
        ],
        models: {
          currentModelId: 'model-0',
          availableModels: Array.from({ length: count }, (_, index) => ({
            modelId: `model-${index}`,
            name: `Model ${index}`,
            _meta: {
              supportsReasoningEffort: true,
              reasoningEfforts: [{ value: 'medium', default: true }]
            }
          }))
        }
      })
      const read = vi.spyOn(options, 'read')
      const session = {
        options,
        connection: {
          initialize: async () => ({
            protocolVersion: 1,
            agentCapabilities: { promptCapabilities: { image: true } }
          })
        }
      }
      for (const mapping of [{ ask: 'default' }, undefined]) {
        read.mockClear()
        modelEfforts.mockClear()
        const result = await readAcpLiveOptions(session, mapping)
        expect({
          reads: read.mock.calls.length,
          modelProjections: modelEfforts.mock.calls.length
        }).toEqual({
          reads: 1,
          modelProjections: count
        })
        expect(result.current).toEqual({
          model: 'model-0',
          effort: 'high',
          confirmed: ['model', 'effort'],
          reportedPermissionMode: mapping ? 'ask' : null
        })
        expect(result.models).toHaveLength(count)
        expect(
          result.models.every(
            (model) =>
              !model.isDefault &&
              model.defaultEffort === 'medium' &&
              model.efforts?.[0]?.value === 'medium'
          )
        ).toBe(true)
        expect(result.catalogListing.models).toBe(result.models)
        expect(result.catalogListing.configuredDefault).toBeUndefined()
        expect(result.acceptsImages).toBe(true)
      }
    }
  )

  it.each([10, 100])(
    'bounds native OMP menu work across %i models, repeated reports and an update',
    async (count) => {
      const options = recordedOmpOptions('loaded', count)
      const read = vi.spyOn(options, 'read')
      const extract = vi.spyOn(SessionConfigSelectOptionSchema, 'safeParse')
      const session = { options, connection: { initialize: async () => ({ protocolVersion: 1 }) } }
      const store = new AgentModelCatalogStore()
      let previousKey: string | undefined
      let visits = 0
      try {
        for (const frame of ['initial', 'repeat', 'update']) {
          if (frame === 'update') {
            // A synthetic native update exercises adoption; the initial menu remains recorded output.
            options.adoptConfigOptions([
              {
                id: 'thinking',
                name: 'Thinking',
                category: 'thought_level',
                type: 'select',
                currentValue: 'auto',
                options: [
                  { value: 'auto', name: 'Auto' },
                  { value: 'high', name: 'High' }
                ]
              }
            ])
          }
          const expected =
            frame === 'update'
              ? [
                  { value: 'auto', label: 'Auto' },
                  { value: 'high', label: 'High' }
                ]
              : [
                  { value: 'off', label: 'Off' },
                  { value: 'auto', label: 'Auto', description: 'Auto-detect per prompt' }
                ]
          read.mockClear()
          extract.mockClear()
          const result = await readAcpLiveOptions(session)
          expect(read).toHaveBeenCalledTimes(1)
          expect(extract).toHaveBeenCalledTimes(2)
          expect(result.models).toHaveLength(count)
          expect(result.models[0]!.efforts).toEqual(expected)
          expect(result.catalogListing.models).toBe(result.models)
          for (const model of result.models) {
            expect(model.efforts).toBe(result.models[0]!.efforts)
            expect(model.effortsKnown).toBe(model.id === 'running' ? undefined : false)
            expect(model.defaultEffort).toBeUndefined()
          }
          for (const choice of result.models[0]!.efforts) {
            const value = choice.value
            Object.defineProperty(choice, 'value', {
              enumerable: true,
              get: () => {
                visits++
                return value
              }
            })
          }
          visits = 0
          const entry = store.recordSuccess(
            'omp-scaling',
            'omp',
            { ...result.catalogListing, origin: 'live-session' },
            'live'
          )!
          // A repeat/update compares old and new source keys; each contains M*E values.
          const publicationVisits = visits
          expect(publicationVisits).toBeLessThanOrEqual(count * 2 * 2)
          expect(entry.models).toHaveLength(count)
          expect(entry.live?.models).toEqual(result.models)
          visits = 0
          const key = agentModelCatalogListingKey(entry)
          expect(visits).toBe(count * 2)
          expect(key.match(/"value":/g)).toHaveLength(count * 2)
          const emptyKey = agentModelCatalogListingKey({
            ...entry,
            live: entry.live
              ? {
                  ...entry.live,
                  models: entry.live.models.map((model) => ({ ...model, efforts: [] }))
                }
              : null
          })
          expect(key.length - emptyKey.length).toBe(count * (JSON.stringify(expected).length - 2))
          if (frame === 'repeat') {
            expect(key).toBe(previousKey)
          }
          if (frame === 'update') {
            expect(key).not.toBe(previousKey)
          }
          previousKey = key
          visits = 0
          const state = applyStructuredAgentSessionModelCatalog(
            createStructuredAgentSessionOptionState('omp'),
            OMP_SESSION_OPTION_CATALOG,
            { origin: 'probe', fetchedAt: 1, models: entry.models },
            { newLaunch: false }
          )
          const installationVisits = visits
          expect(installationVisits).toBe(count)
          const descriptors = state.catalog!.models.flatMap((model) =>
            model.options.filter((option) => option.id === 'effort')
          )
          expect(descriptors).toHaveLength(count)
          let choices = 0
          for (const descriptor of descriptors) {
            expect(descriptor.kind).toMatchObject({ type: 'select', choices: expected })
            expect(descriptor.kind).not.toHaveProperty('defaultIsCliDefault')
            if (descriptor.kind.type === 'select') {
              choices += descriptor.kind.choices.length
            }
          }
          expect(choices).toBe(count * 2)
        }
      } finally {
        extract.mockRestore()
      }
    }
  )

  it.each([OPENCODE_ACP_DIALECT, OMP_ACP_DIALECT])(
    'keeps native menus and observations separate from applied inputs',
    async (dialect) => {
      const options = new AcpStructuredOptions(dialect)
      options.adoptSession({
        configOptions,
        models: { currentModelId: 'legacy', availableModels: [] }
      })
      const { models, current } = options.read()
      // Current values supply an effort menu, never a catalog default.
      expect(models).toEqual([
        {
          id: 'model-a',
          label: 'Model A',
          isDefault: false,
          efforts:
            dialect === OMP_ACP_DIALECT
              ? [
                  { value: 'low', label: 'Low' },
                  { value: 'high', label: 'High' }
                ]
              : [],
          effortsKnown: false
        },
        {
          id: 'model-b',
          label: 'Model B',
          isDefault: false,
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ])
      expect(current).toEqual({ model: 'model-b', effort: 'high', confirmed: ['model', 'effort'] })
      options.notePick('model')
      options.adoptModel('')
      options.adoptConfigOptions(null)
      options.adoptConfigOptions(undefined)
      expect(options.reported()).toEqual({ model: 'model-b', effort: 'high' })
      options.adoptConfigOptions(configOptions)
      expect([...options.appliedInput]).toEqual([])
      await writeAcpSessionOption(
        {
          setConfigOption: async () => ({ configOptions }),
          setModel: async () => ({})
        },
        options,
        options.write('model', 'raw/retired')!,
        {
          agent: 'test',
          key: 'model',
          value: 'raw/retired',
          timeoutMs: 1000
        }
      )
      expect([...options.appliedInput]).toEqual([['model', 'raw/retired']])
      const reports = [
        { model: 'model-a' },
        { model: 'model-b', effort: 'high' },
        {},
        { model: 'model-b', effort: 'high' }
      ]
      for (const [index, next] of [
        [{ ...configOptions[0]!, currentValue: 'model-a' }],
        configOptions,
        [],
        configOptions
      ].entries()) {
        options.adoptConfigOptions(next)
        expect([...options.appliedInput]).toEqual([['model', 'raw/retired']])
        expect(options.reported()).toEqual(reports[index])
      }
      options.adoptSession({ configOptions })
      expect([...options.appliedInput]).toEqual([])
    }
  )

  it('reads each model’s own menu where the agent advertises one', () => {
    const options = new AcpStructuredOptions(GROK_ACP_DIALECT)
    options.adoptSession({
      configOptions,
      models: {
        currentModelId: 'model-b',
        availableModels: [
          {
            modelId: 'model-a',
            name: 'Model A',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEfforts: [{ value: 'medium', default: true }]
            }
          },
          // Display declarations do not change the legacy marker policy.
          {
            modelId: 'model-b',
            name: 'Model B',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: 'high',
              reasoningEfforts: ['low', 'high']
            }
          }
        ]
      }
    })
    expect(options.read().models).toEqual([
      {
        id: 'model-a',
        label: 'Model A',
        isDefault: false,
        efforts: [{ value: 'medium', label: 'Medium' }],
        defaultEffort: 'medium',
        declaredDefaultEffort: 'medium'
      },
      {
        id: 'model-b',
        label: 'Model B',
        isDefault: false,
        declaredDefaultEffort: 'high',
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    ])
    expect(options.reported()).toEqual({ model: 'model-b', effort: 'high' })
  })

  it('keeps the session’s effort menu for the running model when its advertised one is empty', () => {
    const options = new AcpStructuredOptions(GROK_ACP_DIALECT)
    options.adoptSession({
      configOptions,
      models: {
        currentModelId: 'model-b',
        availableModels: [
          { modelId: 'model-a', name: 'Model A' },
          { modelId: 'model-b', name: 'Model B', _meta: { supportsReasoningEffort: false } }
        ]
      }
    })
    const [modelA, modelB] = options.read().models
    expect(modelA?.efforts).toEqual([])
    expect(modelB?.efforts).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ])
    expect(modelB?.defaultEffort).toBeUndefined()
  })
})

describe('what a new session with no pick says about the configured default', () => {
  it('is the model and effort the agent chose for itself', () => {
    const options = new AcpStructuredOptions()
    options.adoptSession({ configOptions }, 'new')
    expect(options.configuredDefault()).toEqual({ modelId: 'model-b', effort: 'high' })
  })

  it('says nothing of a loaded session, which keeps the model it ran', () => {
    const options = new AcpStructuredOptions()
    options.adoptSession({ configOptions })
    expect(options.configuredDefault()).toBeUndefined()
  })

  it('says nothing once the chat holds a model pick, even one the session already runs', () => {
    const options = new AcpStructuredOptions()
    options.adoptSession({ configOptions }, 'new')
    options.notePick('model')
    expect(options.configuredDefault()).toBeUndefined()
  })

  it('keeps the model but not an effort the chat picked', () => {
    const options = new AcpStructuredOptions()
    options.adoptSession({ configOptions }, 'new')
    options.notePick('effort')
    expect(options.configuredDefault()).toEqual({ modelId: 'model-b' })
  })

  it('says nothing when the agent reports no model, so no empty default is saved', () => {
    const noModel = JSON.parse(
      readFileSync(new URL('./fixtures/omp-v17-windows-new-no-model.json', import.meta.url), 'utf8')
    )
    const options = new AcpStructuredOptions()
    options.adoptSession(noModel, 'new')
    expect(options.configuredDefault()).toBeUndefined()
    options.adoptSession({ models: { currentModelId: '', availableModels: [] } }, 'new')
    expect(options.configuredDefault()).toBeUndefined()
  })

  it('retires a saved default when the session runs a model it does not list', () => {
    const options = new AcpStructuredOptions()
    options.adoptSession(
      { configOptions: [{ ...configOptions[0]!, currentValue: 'model-z' }] },
      'new'
    )
    expect(options.configuredDefault()).toBeNull()
  })
})
