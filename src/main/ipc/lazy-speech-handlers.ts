import { ipcMain, type IpcMainEvent } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/execution/commit-message-agent-environment'
import { ensureSpeechServiceFactories } from '../speech/speech-runtime-service'
import { registerLazyIpcHandleGroup } from './lazy-ipc-handle-group'

export const SPEECH_IPC_CHANNELS = [
  'speech:cleanUpDictation',
  'speech:cancelDictationCleanup',
  'speech:getCatalog',
  'speech:getModelStates',
  'speech:getOpenAiApiKeyStatus',
  'speech:saveOpenAiApiKey',
  'speech:clearOpenAiApiKey',
  'speech:getOpenAiCompatibleProvider',
  'speech:saveOpenAiCompatibleProvider',
  'speech:clearOpenAiCompatibleProvider',
  'speech:downloadModel',
  'speech:cancelDownload',
  'speech:deleteModel',
  'speech:startDictation',
  'speech:feedAudio',
  'speech:stopDictation',
  'speech:cancelDictation'
] as const

export function registerLazySpeechHandlers(
  store: Store,
  agentEnvResolvers?: CommitMessageAgentEnvironmentResolvers
): void {
  let audioPortHandler: ((event: IpcMainEvent, sessionId: string) => void) | null = null
  const pendingAudioPortEvents: { event: IpcMainEvent; sessionId: string }[] = []

  ipcMain.on('speech:audioPort', (event, sessionId: string) => {
    if (audioPortHandler) {
      audioPortHandler(event, sessionId)
      return
    }
    pendingAudioPortEvents.push({ event, sessionId })
  })

  registerLazyIpcHandleGroup(SPEECH_IPC_CHANNELS, async (ipc) => {
    const [, { registerSpeechHandlers }] = await Promise.all([
      ensureSpeechServiceFactories(),
      import('./speech')
    ])
    audioPortHandler = registerSpeechHandlers(store, agentEnvResolvers, ipc, {
      attachAudioPortListener: false
    })
    for (const queued of pendingAudioPortEvents.splice(0)) {
      audioPortHandler(queued.event, queued.sessionId)
    }
  })
}
