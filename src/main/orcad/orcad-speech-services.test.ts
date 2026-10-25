import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { getDefaultVoiceSettings } from '../../shared/constants'
import type { VoiceSettings } from '../../shared/speech-types'
import { SPEECH_RECOGNIZER_DIR_ENV } from '../../shared/speech-recognizer-package'
import { isLocalSpeechModel, SPEECH_MODEL_CATALOG } from '../speech/model-catalog'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { LOCAL_SPEECH_UNAVAILABLE_ERROR } from '../speech/stt-worker-paths'
import { RuntimeMobileDictationController } from '../runtime/runtime-mobile-dictation-controller'
import { RuntimeMobileSpeechCatalog } from '../runtime/runtime-mobile-speech-catalog'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { orcadSpeechServiceFactories } from './orcad-speech-services'

const roots: string[] = []
afterEach(() => {
  setSpeechServiceFactories(null)
  delete process.env[SPEECH_RECOGNIZER_DIR_ENV]
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function orcadHost(voice: Partial<VoiceSettings>) {
  const userData = mkdtempSync(join(tmpdir(), 'orcad-speech-'))
  roots.push(userData)
  // A packaged host with no Electron resources tree and no recognizer handed to it.
  installFakeAppEnvironment({ isPackaged: () => true, getPath: () => userData })
  setSpeechServiceFactories(orcadSpeechServiceFactories)
  let settings = { voice: { ...getDefaultVoiceSettings(), ...voice } }
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the speech controllers read only getSettings and updateSettings.
  return store as unknown as RuntimeStore
}

describe('speech on orcad (#31174)', () => {
  it('answers speech.models.list instead of speech_unavailable, with only models it can run', async () => {
    const store = orcadHost({})
    const setup = await new RuntimeMobileSpeechCatalog(() => store).list()
    const cloudIds = SPEECH_MODEL_CATALOG.filter((m) => !isLocalSpeechModel(m)).map((m) => m.id)
    expect(setup.models.map((m) => m.id)).toEqual(cloudIds)
  })

  it('refuses to download an on-device model it could never run', async () => {
    const store = orcadHost({})
    const local = SPEECH_MODEL_CATALOG.find(isLocalSpeechModel)
    await expect(new RuntimeMobileSpeechCatalog(() => store).download(local!.id)).rejects.toThrow(
      'voice_model_not_downloadable'
    )
  })

  // Every mobile build opens the setup sheet on `voice_model_not_ready:`, so older phones recover.
  it('sends a phone with an on-device model selected to the setup sheet', async () => {
    const local = SPEECH_MODEL_CATALOG.find(isLocalSpeechModel)
    const store = orcadHost({ enabled: true, sttModel: local!.id })
    await expect(
      new RuntimeMobileDictationController(() => store).start({
        dictationId: 'd-1',
        clientId: 'phone'
      })
    ).rejects.toThrow(LOCAL_SPEECH_UNAVAILABLE_ERROR)
  })
})
