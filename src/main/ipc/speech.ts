import {
  ipcMain,
  BrowserWindow,
  systemPreferences,
  type IpcMainInvokeEvent,
  type MessagePortMain
} from 'electron'
import { abortWhenRendererGone } from './renderer-lifetime-abort'
import { mergeDictationTerms } from '../../shared/dictation-dictionary'
import { SPEECH_MODEL_CATALOG } from '../speech/model-catalog'
import { deleteLocalSpeechModel } from '../speech/speech-model-deletion'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import {
  clearOpenAiSpeechApiKey,
  getOpenAiSpeechApiKeyProtection,
  hasOpenAiSpeechApiKey
} from '../speech/openai-api-key-store'
import {
  saveVerifiedOpenAiCompatibleSpeechProvider,
  saveVerifiedOpenAiSpeechApiKey
} from '../speech/openai-api-key-verification'
import {
  clearOpenAiCompatibleSpeechProvider,
  summarizeOpenAiCompatibleSpeechProvider
} from '../speech/openai-compatible-speech-provider-store'
import type { DictationContext, OpenAiCompatibleSpeechProvider } from '../../shared/speech-types'
import type { Store } from '../persistence/loading-store/store'

export function registerSpeechHandlers(store: Store): void {
  ipcMain.handle('speech:getCatalog', () => {
    return SPEECH_MODEL_CATALOG
  })

  ipcMain.handle('speech:getModelStates', async () => {
    return getSpeechModelManager(store).getModelStates()
  })

  ipcMain.handle('speech:getOpenAiApiKeyStatus', async () => {
    return { configured: hasOpenAiSpeechApiKey(), protection: getOpenAiSpeechApiKeyProtection() }
  })

  ipcMain.handle('speech:saveOpenAiApiKey', async (_event, apiKey: string) => {
    await saveVerifiedOpenAiSpeechApiKey(apiKey)
    return { configured: true, protection: getOpenAiSpeechApiKeyProtection() }
  })

  ipcMain.handle('speech:clearOpenAiApiKey', async () => {
    clearOpenAiSpeechApiKey()
    return { configured: false, protection: null }
  })

  ipcMain.handle('speech:getOpenAiCompatibleProvider', () => {
    try {
      return summarizeOpenAiCompatibleSpeechProvider()
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'speech:saveOpenAiCompatibleProvider',
    async (_event, input: OpenAiCompatibleSpeechProvider) => {
      await saveVerifiedOpenAiCompatibleSpeechProvider(input)
    }
  )

  ipcMain.handle('speech:clearOpenAiCompatibleProvider', () => {
    clearOpenAiCompatibleSpeechProvider()
  })

  ipcMain.handle('speech:downloadModel', async (event, modelId: string) => {
    const manager = getSpeechModelManager(store)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return
    }
    const clearProgressCallback = manager.setProgressCallback((id, progress) => {
      if (!window.isDestroyed()) {
        window.webContents.send('speech:downloadProgress', { modelId: id, progress })
      }
    })
    // Scope process-wide model progress callbacks to the download/window lifetime to avoid retaining stale windows.
    let progressCallbackCleared = false
    const cleanupProgressCallback = (): void => {
      if (progressCallbackCleared) {
        return
      }
      progressCallbackCleared = true
      window.off('closed', cleanupProgressCallback)
      clearProgressCallback()
    }
    window.once('closed', cleanupProgressCallback)
    try {
      await manager.downloadModel(modelId)
    } finally {
      cleanupProgressCallback()
    }
  })

  ipcMain.handle('speech:cancelDownload', async (_event, modelId: string) => {
    getSpeechModelManager(store).cancelDownload(modelId)
  })

  ipcMain.handle('speech:deleteModel', async (_event, modelId: string) => {
    await deleteLocalSpeechModel({
      store,
      modelManager: getSpeechModelManager(store),
      sttService: getSpeechSttService(store),
      modelId
    })
  })

  // Renderer run ids restart per document; a retired document's owner must not be reused by its successor.
  const retiredDocumentCounts = new Map<number, number>()
  const getDesktopOwner = (senderId: number, sessionId: string): string =>
    `desktop:${senderId}:${retiredDocumentCounts.get(senderId) ?? 0}:${sessionId}`

  const dictationListeners = new Map<number, { owner: string; cleanup: () => void }>()

  // The preload posts a session's audio port just before its start, on the same ordered pipe.
  const pendingAudioPorts = new Map<string, MessagePortMain>()
  ipcMain.on('speech:audioPort', (event, sessionId: string) => {
    const port = event.ports[0]
    if (port) {
      pendingAudioPorts.set(getDesktopOwner(event.sender.id, sessionId), port)
    }
  })

  ipcMain.handle(
    'speech:startDictation',
    async (event, modelId: string, context?: DictationContext, sessionId = 'desktop') => {
      const senderId = event.sender.id
      const owner = getDesktopOwner(senderId, sessionId)
      const audioPort = pendingAudioPorts.get(owner)
      pendingAudioPorts.delete(owner)
      let directAudio = false
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        audioPort?.close()
        return { directAudio }
      }
      let rendererRetired = false
      const rendererLifetime = abortWhenRendererGone(event.sender)
      let sessionListenerRemoved = false
      let sessionReady = false
      const cleanupOnRendererGone = (): void => {
        if (!rendererRetired && getDesktopOwner(senderId, sessionId) === owner) {
          retiredDocumentCounts.set(senderId, (retiredDocumentCounts.get(senderId) ?? 0) + 1)
        }
        rendererRetired = true
        cleanupSessionListener()
        void getSpeechSttService(store)
          .stopDictation(owner, { discard: true })
          .catch(() => {})
      }
      const cleanupSessionListener = (): void => {
        sessionListenerRemoved = true
        window.off('closed', cleanupOnRendererGone)
        rendererLifetime.dispose()
        if (dictationListeners.get(senderId)?.cleanup === cleanupSessionListener) {
          dictationListeners.delete(senderId)
        }
      }
      window.once('closed', cleanupOnRendererGone)
      rendererLifetime.signal.addEventListener('abort', cleanupOnRendererGone, { once: true })

      try {
        // macOS can return silent microphone streams without TCC permission; request it before capture.
        if (process.platform === 'darwin') {
          const micStatus = systemPreferences.getMediaAccessStatus('microphone')
          if (micStatus !== 'granted') {
            await systemPreferences.askForMediaAccess('microphone')
            const newStatus = systemPreferences.getMediaAccessStatus('microphone')
            if (newStatus !== 'granted') {
              throw new Error(
                'Microphone access not granted. In System Settings > Privacy & Security > Microphone, ' +
                  'click "+" and add the Electron app, then restart Orca.'
              )
            }
          }
        }

        if (rendererRetired || window.isDestroyed()) {
          cleanupSessionListener()
          return { directAudio }
        }

        await getSpeechSttService(store).startDictation(
          modelId,
          (msg) => {
            if (msg.type === 'ready') {
              sessionReady = true
            }
            if (rendererRetired || window.isDestroyed()) {
              return
            }
            switch (msg.type) {
              case 'ready':
                window.webContents.send('speech:ready', { sessionId })
                break
              case 'partial':
                window.webContents.send('speech:partial', { text: msg.text ?? '', sessionId })
                break
              case 'final':
                window.webContents.send('speech:final', { text: msg.text ?? '', sessionId })
                break
              case 'stopped':
                cleanupSessionListener()
                window.webContents.send('speech:stopped', { sessionId })
                break
              case 'error':
                window.webContents.send('speech:error', { error: msg.error ?? '', sessionId })
                void getSpeechSttService(store)
                  .stopDictation(owner)
                  .catch(() => undefined)
                  .finally(cleanupSessionListener)
                break
            }
          },
          mergeDictationTerms(context?.repoTerms, store.getSettings().voice?.dictationTerms),
          owner,
          store.getSettings().voice
        )
        // Coalesced starts install no sink; only an accepted start supersedes the close hook.
        if (sessionReady) {
          directAudio =
            audioPort !== undefined && getSpeechSttService(store).attachAudioPort(owner, audioPort)
          dictationListeners.get(senderId)?.cleanup()
          if (!sessionListenerRemoved) {
            dictationListeners.set(senderId, { owner, cleanup: cleanupSessionListener })
          }
        } else {
          cleanupSessionListener()
        }
        return { directAudio }
      } catch (err) {
        cleanupSessionListener()
        throw err
      } finally {
        if (!directAudio) {
          audioPort?.close()
        }
      }
    }
  )

  ipcMain.handle(
    'speech:feedAudio',
    async (_event, buffer: Buffer, sampleRate: number, sessionId = 'desktop') => {
      // Preload uses Buffer because contextBridge/IPC can zero Float32Array data.
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      return getSpeechSttService(store).feedAudio(
        samples,
        sampleRate,
        getDesktopOwner(_event.sender.id, sessionId)
      )
    }
  )

  const handleStop =
    (discard: boolean) =>
    async (event: IpcMainInvokeEvent, sessionId = 'desktop'): Promise<void> => {
      const owner = getDesktopOwner(event.sender.id, sessionId)
      const listener = dictationListeners.get(event.sender.id)
      await getSpeechSttService(store).stopDictation(owner, { discard })
      if (listener?.owner === owner) {
        listener.cleanup()
      }
    }
  ipcMain.handle('speech:stopDictation', handleStop(false))
  ipcMain.handle('speech:cancelDictation', handleStop(true))
}
