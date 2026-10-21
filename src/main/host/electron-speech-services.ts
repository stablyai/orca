import { net } from 'electron'
import { ModelManager } from '../speech/model-manager'
import { SttService } from '../speech/stt-service'
import type { SpeechServiceFactories } from '../speech/speech-runtime-service'
import type {
  DownloadIncomingMessage,
  OpenSpeechDownloadRequest
} from '../speech/speech-model-download-response'

/** Why Chromium's stack: it honors the app's proxy settings, which Node's `https` does not. */
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

/** The desktop speech factories. Importing this file is what pulls Electron's net in. */
export const electronSpeechServiceFactories: SpeechServiceFactories = {
  createModelManager: (customModelsDir) =>
    new ModelManager(customModelsDir, openElectronSpeechDownloadRequest),
  createSttService: (models) => new SttService(models)
}
