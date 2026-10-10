import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AcpStructuredOptions, restoreAcpSessionOptions } from './acp-structured-options'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'

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
  it('keeps the session’s picks out of the catalog facts', () => {
    const options = new AcpStructuredOptions()
    options.adoptSession({ configOptions })
    const { models, current } = options.read()
    // The effort menu belongs to the model running now; nothing is anyone's default.
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
          // The session's own effort written into the running model's meta is not its default.
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
  const connection = {
    setConfigOption: async () => ({ configOptions }),
    setModel: async () => ({})
  }

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

  it('says nothing once the chat holds a model pick, even one the session already runs', async () => {
    const options = new AcpStructuredOptions()
    options.adoptSession({ configOptions }, 'new')
    await restoreAcpSessionOptions(connection, options, { model: 'model-b' })
    expect(options.configuredDefault()).toBeUndefined()
  })

  it('keeps the model but not an effort the chat picked', async () => {
    const options = new AcpStructuredOptions()
    options.adoptSession({ configOptions }, 'new')
    await restoreAcpSessionOptions(connection, options, { effort: 'low' })
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
