import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../shared/constants'
import type { RuntimeStore } from './runtime-store-contract'
import { RuntimeMobileSpeechCatalog } from './runtime-mobile-speech-catalog'
import { RuntimeMobileDictationController } from './runtime-mobile-dictation-controller'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { orcadSpeechServiceFactories } from '../orcad/orcad-speech-services'
import { getCatalogModel } from '../speech/model-catalog'

vi.mock('../speech/macos-speech-helper', () => ({
  getMacosSpeechHelperPath: () => '/test/orca-speech'
}))

const roots: string[] = []
afterEach(() => {
  setSpeechServiceFactories(null)
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function host() {
  const modelsDir = mkdtempSync(join(tmpdir(), 'orca-mobile-macos-speech-'))
  roots.push(modelsDir)
  setSpeechServiceFactories(orcadSpeechServiceFactories)
  const updateSettings = vi.fn()
  const runtimeStore: RuntimeStore = {
    getRepos: () => [],
    getRepo: () => undefined,
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
    removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getSettings: () => ({
      workspaceDir: modelsDir,
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: '',
      voice: { ...getDefaultVoiceSettings(), enabled: true, sttModel: 'macos-native', modelsDir }
    }),
    updateSettings
  }
  return { runtimeStore, updateSettings }
}

describe('system speech with existing mobile clients', () => {
  it('omits the desktop engine instead of offering invalid download/delete controls', async () => {
    const { runtimeStore } = host()
    expect(getCatalogModel('macos-native')).toBeDefined()
    const catalog = new RuntimeMobileSpeechCatalog(() => runtimeStore)
    const setup = await catalog.list()
    expect(setup.models.some((model) => model.id === 'macos-native')).toBe(false)
    expect(setup.models.some((model) => model.provider === 'openai')).toBe(true)
  })

  it('rejects a stale selection without updating the shared voice settings', async () => {
    const { runtimeStore, updateSettings } = host()
    const catalog = new RuntimeMobileSpeechCatalog(() => runtimeStore)
    await expect(catalog.configure({ modelId: 'macos-native' })).rejects.toThrow(
      'voice_model_unknown'
    )
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('returns the setup-required error when desktop settings select the unsupported mobile engine', async () => {
    const { runtimeStore } = host()
    const dictation = new RuntimeMobileDictationController(() => runtimeStore)
    await expect(dictation.start({ dictationId: 'native', clientId: 'phone' })).rejects.toThrow(
      'voice_model_not_ready:unavailable'
    )
  })
})
