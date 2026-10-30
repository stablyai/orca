import { describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../shared/constants'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { VoiceSettings } from '../../shared/speech-types'
import type { RuntimeStore } from './runtime-store-contract'

vi.mock('../speech/speech-runtime-service', () => ({
  getSpeechModelManager: () => ({ getModelStates: async () => [] }),
  getSpeechSttService: () => ({})
}))
vi.mock('../speech/stt-worker-paths', () => ({ hasLocalSpeechRecognizer: () => true }))

const { RuntimeMobileSpeechCatalog } = await import('./runtime-mobile-speech-catalog')

function catalogWith(voice: Partial<VoiceSettings>) {
  const store: Pick<RuntimeStore, 'getSettings'> = {
    getSettings: () =>
      createGlobalSettingsFixture({ voice: { ...getDefaultVoiceSettings(), ...voice } })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: list() reads only getSettings, which the Pick checks; the model manager is mocked above.
  return new RuntimeMobileSpeechCatalog(() => store as RuntimeStore)
}

// The phone follows the desktop's "Send when dictation ends" through the setup reply.
describe('the speech setup reply and dictation auto-send', () => {
  it('carries the setting and its delay', async () => {
    const setup = await catalogWith({ autoSendAfterDictation: true, autoSendDelayMs: 3000 }).list()
    expect(setup).toMatchObject({ autoSendAfterDictation: true, autoSendDelayMs: 3000 })
  })

  it('reports off with the default delay until the user turns it on', async () => {
    const setup = await catalogWith({}).list()
    expect(setup).toMatchObject({ autoSendAfterDictation: false, autoSendDelayMs: 2000 })
  })

  it('sends the default for a delay the picker does not offer', async () => {
    const setup = await catalogWith({ autoSendAfterDictation: true, autoSendDelayMs: 7000 }).list()
    expect(setup.autoSendDelayMs).toBe(2000)
  })
})
