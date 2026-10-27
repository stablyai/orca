import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AcpStructuredOptions, readAcpLiveOptions } from './acp-structured-options'
import { grokModelEfforts } from './acp-dialects/grok-model-catalog'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'

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
      const options = new AcpStructuredOptions({ ...GROK_ACP_DIALECT, modelEfforts })
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

  it('keeps the session’s picks out of the catalog facts', () => {
    // OpenCode refuses an effort the selected model lacks, so another model's empty menu stays strict.
    const options = new AcpStructuredOptions(OPENCODE_ACP_DIALECT)
    options.adoptSession({ configOptions })
    const { models, current } = options.read()
    // Current values supply an effort menu, never a catalog default.
    expect(models).toEqual([
      { id: 'model-a', label: 'Model A', isDefault: false, efforts: [] },
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
  })

  it('leaves another model’s menu unknown for an agent that clamps unlisted efforts', () => {
    const options = new AcpStructuredOptions(OMP_ACP_DIALECT)
    options.adoptSession({ configOptions })
    expect(options.read().models[0]).toEqual({
      id: 'model-a',
      label: 'Model A',
      isDefault: false,
      efforts: [],
      effortsKnown: false
    })
  })

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
          // Session-selected effort metadata must not become a model default.
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
        defaultEffort: 'medium'
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
