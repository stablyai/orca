import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { RuntimeMobileSpeechCatalog } from './runtime-mobile-speech-catalog'
import type { RuntimeStore } from './runtime-store-contract'

const { getModelStates } = vi.hoisted(() => ({ getModelStates: vi.fn() }))

vi.mock('../speech/speech-runtime-service', () => ({
  getSpeechModelManager: () => ({ getModelStates }),
  getSpeechSttService: vi.fn()
}))

function makeStore(): RuntimeStore {
  return {
    getRepos: vi.fn(),
    getRepo: vi.fn(),
    addRepo: vi.fn(),
    updateRepo: vi.fn(),
    getAllWorktreeMeta: vi.fn(),
    getWorktreeMeta: vi.fn(),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getGitHubCache: vi.fn(),
    getSettings: () => getDefaultSettings('/test')
  }
}

describe('mobile speech catalog', () => {
  it('preserves OpenRouter provider and readiness without changing existing model providers', async () => {
    getModelStates.mockResolvedValue([{ id: 'openrouter-mai-transcribe-2', status: 'ready' }])
    const catalog = new RuntimeMobileSpeechCatalog(makeStore)
    const { models } = await catalog.list()

    expect(models.find((model) => model.id === 'openrouter-mai-transcribe-2')).toEqual({
      id: 'openrouter-mai-transcribe-2',
      label: 'MAI-Transcribe 2',
      provider: 'openrouter',
      status: 'ready',
      sizeBytes: null,
      recommended: false,
      progress: null
    })
    expect(models.find((model) => model.id === 'openai-gpt-4o-mini-transcribe')?.provider).toBe(
      'openai'
    )
    expect(models.find((model) => model.id === 'parakeet-tdt-0.6b-v3-int8')?.provider).toBe('local')
    await expect(catalog.download('openrouter-mai-transcribe-2')).rejects.toThrow(
      'voice_model_not_downloadable'
    )
  })
})
