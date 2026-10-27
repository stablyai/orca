import { ipcMain, BrowserWindow, systemPreferences } from 'electron'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { SPEECH_MODEL_CATALOG } from '../speech/model-catalog'
import { deleteLocalSpeechModel } from '../speech/speech-model-deletion'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import {
  clearOpenAiSpeechApiKey,
  getOpenAiSpeechApiKeyProtection,
  hasOpenAiSpeechApiKey,
  saveOpenAiSpeechApiKey
} from '../speech/openai-api-key-store'
import type { Store } from '../persistence'

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
    saveOpenAiSpeechApiKey(apiKey)
    return { configured: true, protection: getOpenAiSpeechApiKeyProtection() }
  })

  ipcMain.handle('speech:clearOpenAiApiKey', async () => {
    clearOpenAiSpeechApiKey()
    return { configured: false, protection: null }
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

  const getHotwordsFilePath = (content: string): string => {
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
    // sherpa-onnx cannot read non-ASCII Windows paths; use the ASCII-safe model cache for hotwords.
    return join(getSpeechModelManager(store).getModelsDir(), `speech-hotwords-${digest}.txt`)
  }

  const getDesktopOwner = (senderId: number, sessionId: string): string =>
    `desktop:${senderId}:${sessionId}`

  const dictationListeners = new Map<number, { owner: string; cleanup: () => void }>()

  ipcMain.handle(
    'speech:startDictation',
    async (event, modelId: string, hotwords?: string[], sessionId = 'desktop') => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        return
      }
      let resolvedHotwordsPath: string | undefined
      let windowClosed = false
      const senderId = event.sender.id
      const owner = getDesktopOwner(senderId, sessionId)
      let sessionListenerRemoved = false
      let sessionReady = false
      const cleanupOnWindowClosed = (): void => {
        windowClosed = true
        cleanupSessionListener()
        void getSpeechSttService(store)
          .stopDictation(owner)
          .finally(() => {
            if (resolvedHotwordsPath) {
              unlink(resolvedHotwordsPath).catch(() => {})
            }
          })
          .catch(() => {})
      }
      const cleanupSessionListener = (): void => {
        sessionListenerRemoved = true
        window.off('closed', cleanupOnWindowClosed)
        if (dictationListeners.get(senderId)?.cleanup === cleanupSessionListener) {
          dictationListeners.delete(senderId)
        }
      }
      window.once('closed', cleanupOnWindowClosed)

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

        if (hotwords && hotwords.length > 0) {
          const content = `${hotwords.map((w) => `${w} :2.0`).join('\n')}\n`
          const hotwordsFilePath = getHotwordsFilePath(content)
          await writeFile(hotwordsFilePath, content, 'utf-8')
          resolvedHotwordsPath = hotwordsFilePath
        }

        if (windowClosed || window.isDestroyed()) {
          cleanupSessionListener()
          if (resolvedHotwordsPath) {
            unlink(resolvedHotwordsPath).catch(() => {})
          }
          return
        }

        await getSpeechSttService(store).startDictation(
          modelId,
          (msg) => {
            if (msg.type === 'ready') {
              sessionReady = true
            }
            if (window.isDestroyed()) {
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
          resolvedHotwordsPath,
          owner
        )
        // Coalesced starts install no sink; only an accepted start supersedes the close hook.
        if (sessionReady) {
          dictationListeners.get(senderId)?.cleanup()
          if (!sessionListenerRemoved) {
            dictationListeners.set(senderId, { owner, cleanup: cleanupSessionListener })
          }
        } else {
          cleanupSessionListener()
        }
        if (resolvedHotwordsPath) {
          unlink(resolvedHotwordsPath).catch(() => {})
        }
      } catch (err) {
        cleanupSessionListener()
        if (resolvedHotwordsPath) {
          unlink(resolvedHotwordsPath).catch(() => {})
        }
        throw err
      }
    }
  )

  ipcMain.handle(
    'speech:feedAudio',
    async (_event, buffer: Buffer, sampleRate: number, sessionId = 'desktop') => {
      // Preload uses Buffer because contextBridge/IPC can zero Float32Array data.
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      getSpeechSttService(store).feedAudio(
        samples,
        sampleRate,
        getDesktopOwner(_event.sender.id, sessionId)
      )
    }
  )

  ipcMain.handle('speech:stopDictation', async (_event, sessionId = 'desktop') => {
    const owner = getDesktopOwner(_event.sender.id, sessionId)
    const listener = dictationListeners.get(_event.sender.id)
    await getSpeechSttService(store).stopDictation(owner)
    if (listener?.owner === owner) {
      listener.cleanup()
    }
  })
}
