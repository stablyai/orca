import { expect, it } from 'vitest'
import type { RuntimeSpeechSetupState } from '../../../../../shared/worktree/catalog/runtime-worktree-contracts'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { SPEECH_METHODS } from './speech'

it.each([
  ['speech.models.list', null],
  ['speech.dictation.setup', { enabled: true }],
  ['speech.models.delete', { modelId: 'local-model' }]
])(
  'keeps subscription download/delete controls off older phones in %s replies',
  async (name, params) => {
    const setup: RuntimeSpeechSetupState = {
      enabled: true,
      selectedModelId: '',
      dictationMode: 'toggle',
      dictationHoldToRecord: true,
      removeFillerWords: true,
      stopAfterSilenceSeconds: 60,
      dictationTerms: [],
      models: [
        {
          id: 'local-model',
          label: 'Local',
          provider: 'local',
          status: 'ready',
          sizeBytes: 1,
          recommended: false,
          progress: null
        },
        {
          id: 'chatgpt-subscription-transcribe',
          label: 'ChatGPT',
          provider: 'chatgpt',
          status: 'not-downloaded',
          sizeBytes: null,
          recommended: false,
          progress: null
        }
      ]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers use only the three supplied runtime methods.
    const runtime = {
      listMobileSpeechModels: async () => setup,
      configureMobileDictation: async () => setup,
      deleteMobileSpeechModel: async () => setup
    } as unknown as OrcaRuntimeService
    const method = eraseRpcMethods(SPEECH_METHODS).find((entry) => entry.name === name)!
    const legacy = await method.handler(params, { runtime, clientKind: 'mobile' })
    expect(legacy).toMatchObject({ models: [{ id: 'local-model' }] })
    const current = await method.handler(params, {
      runtime,
      clientKind: 'mobile',
      clientCapabilities: ['speech.chatgpt-accounts.v1']
    } satisfies RpcContext)
    expect(current).toMatchObject({
      models: [{ id: 'local-model' }, { id: 'chatgpt-subscription-transcribe' }]
    })
  }
)
