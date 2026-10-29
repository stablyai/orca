import { net } from 'electron'
import { ModelManager } from '../speech/model-manager'
import { SttService } from '../speech/stt-service'
import type { SpeechServiceFactories } from '../speech/speech-runtime-service'
import type {
  DownloadIncomingMessage,
  OpenSpeechDownloadRequest
} from '../speech/speech-model-download-response'

/** Chromium honors the app's proxy settings; Node https does not. */
export const openElectronSpeechDownloadRequest: OpenSpeechDownloadRequest = (url) => {
  const request = net.request({ method: 'GET', url })
  return {
    setHeader: (name, value) => {
      request.setHeader(name, value)
    },
    listen: ({ error, response, redirect }) => {
      const onResponse = (incoming: Electron.IncomingMessage): void =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron's IncomingMessage is a Readable stream at runtime; its typings omit the stream half.
        response(incoming as unknown as DownloadIncomingMessage)
      request.on('error', error)
      request.on('response', onResponse)
      request.on('redirect', redirect)
      return () => {
        request.off('error', error)
        request.off('response', onResponse)
        request.off('redirect', redirect)
      }
    },
    abort: () => {
      request.abort()
    },
    end: () => {
      request.end()
    }
  }
}

/** Importing these factories loads Electron net. */
export const electronSpeechServiceFactories: SpeechServiceFactories = {
  createModelManager: (customModelsDir) =>
    new ModelManager(customModelsDir, openElectronSpeechDownloadRequest),
  createSttService: (models) => new SttService(models)
}
