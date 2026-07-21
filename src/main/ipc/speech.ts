import { ipcMain, BrowserWindow, systemPreferences, type IpcMainInvokeEvent } from 'electron'

import { SPEECH_MODEL_CATALOG } from '../speech/model-catalog'
import { deleteLocalSpeechModel } from '../speech/speech-model-deletion'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import {
  clearOpenAiSpeechApiKey,
  hasOpenAiSpeechApiKey,
  saveOpenAiSpeechApiKey
} from '../speech/openai-api-key-store'
import type { Store } from '../persistence'
import { removeSpeechHotwordsFile, writeSpeechHotwordsFile } from '../speech/hotwords-file'
import { isTrustedUIRenderer } from './ui'

function assertTrustedSpeechSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedUIRenderer(event.sender)) {
    throw new Error('Unauthorized speech IPC sender')
  }
}

export function registerSpeechHandlers(store: Store): void {
  ipcMain.handle('speech:getCatalog', (event) => {
    assertTrustedSpeechSender(event)
    return SPEECH_MODEL_CATALOG
  })

  ipcMain.handle('speech:getModelStates', async (event) => {
    assertTrustedSpeechSender(event)
    return getSpeechModelManager(store).getModelStates()
  })

  ipcMain.handle('speech:getOpenAiApiKeyStatus', async (event) => {
    assertTrustedSpeechSender(event)
    return { configured: hasOpenAiSpeechApiKey() }
  })

  ipcMain.handle('speech:saveOpenAiApiKey', async (event, apiKey: string) => {
    assertTrustedSpeechSender(event)
    saveOpenAiSpeechApiKey(apiKey)
    return { configured: true }
  })

  ipcMain.handle('speech:clearOpenAiApiKey', async (event) => {
    assertTrustedSpeechSender(event)
    clearOpenAiSpeechApiKey()
    return { configured: false }
  })

  ipcMain.handle('speech:downloadModel', async (event, modelId: string) => {
    assertTrustedSpeechSender(event)
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
    // Why: ModelManager is process-wide; scope this BrowserWindow closure to
    // the download/window lifetime so stale windows are not retained.
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

  ipcMain.handle('speech:cancelDownload', async (event, modelId: string) => {
    assertTrustedSpeechSender(event)
    getSpeechModelManager(store).cancelDownload(modelId)
  })

  ipcMain.handle('speech:deleteModel', async (event, modelId: string) => {
    assertTrustedSpeechSender(event)
    await deleteLocalSpeechModel({
      store,
      modelManager: getSpeechModelManager(store),
      sttService: getSpeechSttService(store),
      modelId
    })
  })

  const getDesktopOwner = (senderId: number, sessionId: string): string =>
    `desktop:${senderId}:${sessionId}`

  ipcMain.handle(
    'speech:startDictation',
    async (event, modelId: string, hotwords?: string[], sessionId = 'desktop') => {
      assertTrustedSpeechSender(event)
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        return
      }
      let resolvedHotwordsPath: string | undefined
      let windowClosed = false
      const owner = getDesktopOwner(event.sender.id, sessionId)
      const cleanupOnWindowClosed = (): void => {
        windowClosed = true
        void getSpeechSttService(store)
          .stopDictation(owner)
          .finally(() => {
            removeSpeechHotwordsFile(resolvedHotwordsPath)
          })
          .catch(() => {})
      }
      const cleanupSessionListener = (): void => {
        window.off('closed', cleanupOnWindowClosed)
      }
      window.once('closed', cleanupOnWindowClosed)

      try {
        // Why: on macOS, the Electron binary needs explicit TCC permission for
        // the microphone. Without it, getUserMedia succeeds but returns a silent
        // stream (all zeros). Check status and attempt to trigger the system
        // permission prompt if not yet granted.
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

        resolvedHotwordsPath = await writeSpeechHotwordsFile(
          hotwords,
          getSpeechModelManager(store).getModelsDir()
        )

        if (windowClosed || window.isDestroyed()) {
          removeSpeechHotwordsFile(resolvedHotwordsPath)
          return
        }

        await getSpeechSttService(store).startDictation(
          modelId,
          (msg) => {
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
        removeSpeechHotwordsFile(resolvedHotwordsPath)
      } catch (err) {
        cleanupSessionListener()
        removeSpeechHotwordsFile(resolvedHotwordsPath)
        throw err
      }
    }
  )

  ipcMain.handle(
    'speech:feedAudio',
    async (event, buffer: Buffer, sampleRate: number, sessionId = 'desktop') => {
      assertTrustedSpeechSender(event)
      // Why: the preload sends audio as a Buffer to avoid Float32Array data
      // being zeroed out during contextBridge + IPC serialization.
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      getSpeechSttService(store).feedAudio(
        samples,
        sampleRate,
        getDesktopOwner(event.sender.id, sessionId)
      )
    }
  )

  ipcMain.handle('speech:stopDictation', async (event, sessionId = 'desktop') => {
    assertTrustedSpeechSender(event)
    await getSpeechSttService(store).stopDictation(getDesktopOwner(event.sender.id, sessionId))
  })
}
