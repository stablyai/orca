import { ipcMain, BrowserWindow, systemPreferences } from 'electron'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { SPEECH_MODEL_CATALOG } from '../speech/model-catalog'
import { deleteLocalSpeechModel } from '../speech/speech-model-deletion'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import {
  clearOpenAiSpeechApiKey,
  hasOpenAiSpeechApiKey,
  saveOpenAiSpeechApiKey
} from '../speech/openai-api-key-store'
import type { Store } from '../persistence'
import {
  buildSpeechHotwordsContent,
  decodeSpeechAudioChunk,
  SpeechIpcAdmission,
  validateOpenAiSpeechApiKey,
  validateSpeechModelId,
  validateSpeechSessionId
} from './speech-ipc-admission'

const speechAdmission = new SpeechIpcAdmission()

export function clearSpeechIpcAdmissionForTests(): void {
  speechAdmission.reset()
}

export function getPendingDesktopDictationStartCountForTest(): number {
  return speechAdmission.pendingStartCount
}

export function getActiveDesktopDictationListenerCountForTest(): number {
  return speechAdmission.activeListenerCount
}

export function registerSpeechHandlers(store: Store): void {
  ipcMain.handle('speech:getCatalog', () => {
    return SPEECH_MODEL_CATALOG
  })

  ipcMain.handle('speech:getModelStates', async () => {
    return getSpeechModelManager(store).getModelStates()
  })

  ipcMain.handle('speech:getOpenAiApiKeyStatus', async () => {
    return { configured: hasOpenAiSpeechApiKey() }
  })

  ipcMain.handle('speech:saveOpenAiApiKey', async (_event, apiKey: string) => {
    saveOpenAiSpeechApiKey(validateOpenAiSpeechApiKey(apiKey))
    return { configured: true }
  })

  ipcMain.handle('speech:clearOpenAiApiKey', async () => {
    clearOpenAiSpeechApiKey()
    return { configured: false }
  })

  ipcMain.handle('speech:downloadModel', async (event, modelId: string) => {
    const validatedModelId = validateSpeechModelId(modelId)
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
      await manager.downloadModel(validatedModelId)
    } finally {
      cleanupProgressCallback()
    }
  })

  ipcMain.handle('speech:cancelDownload', async (_event, modelId: string) => {
    getSpeechModelManager(store).cancelDownload(validateSpeechModelId(modelId))
  })

  ipcMain.handle('speech:deleteModel', async (_event, modelId: string) => {
    const validatedModelId = validateSpeechModelId(modelId)
    await deleteLocalSpeechModel({
      store,
      modelManager: getSpeechModelManager(store),
      sttService: getSpeechSttService(store),
      modelId: validatedModelId
    })
  })

  const getHotwordsFilePath = (content: string): string => {
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
    // Why: sherpa-onnx cannot read non-ASCII Windows paths, so co-locate the
    // hotwords file with the ASCII-safe model cache instead of userData.
    return join(getSpeechModelManager(store).getModelsDir(), `speech-hotwords-${digest}.txt`)
  }

  const getDesktopOwner = (senderId: number, sessionId: string): string =>
    `desktop:${senderId}:${sessionId}`

  ipcMain.handle(
    'speech:startDictation',
    async (event, modelId: string, hotwords?: string[], sessionId = 'desktop') => {
      const validatedModelId = validateSpeechModelId(modelId)
      const validatedSessionId = validateSpeechSessionId(sessionId)
      const hotwordsContent = buildSpeechHotwordsContent(hotwords)
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        return
      }
      let resolvedHotwordsPath: string | undefined
      let windowClosed = false
      let sessionListenerReleased = false
      const owner = getDesktopOwner(event.sender.id, validatedSessionId)
      speechAdmission.claimStart(owner)
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
        if (sessionListenerReleased) {
          return
        }
        sessionListenerReleased = true
        window.off('closed', cleanupOnWindowClosed)
        speechAdmission.deleteListenerIfCurrent(owner, sessionListener)
      }
      const sessionListener = { release: cleanupSessionListener }
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

        if (hotwordsContent) {
          const hotwordsFilePath = getHotwordsFilePath(hotwordsContent)
          await writeFile(hotwordsFilePath, hotwordsContent, 'utf-8')
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
          validatedModelId,
          (msg) => {
            if (window.isDestroyed()) {
              return
            }
            switch (msg.type) {
              case 'ready':
                window.webContents.send('speech:ready', { sessionId: validatedSessionId })
                break
              case 'partial':
                window.webContents.send('speech:partial', {
                  text: msg.text ?? '',
                  sessionId: validatedSessionId
                })
                break
              case 'final':
                window.webContents.send('speech:final', {
                  text: msg.text ?? '',
                  sessionId: validatedSessionId
                })
                break
              case 'stopped':
                cleanupSessionListener()
                window.webContents.send('speech:stopped', { sessionId: validatedSessionId })
                break
              case 'error':
                window.webContents.send('speech:error', {
                  error: msg.error ?? '',
                  sessionId: validatedSessionId
                })
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
        if (windowClosed || window.isDestroyed() || sessionListenerReleased) {
          cleanupSessionListener()
          if (resolvedHotwordsPath) {
            unlink(resolvedHotwordsPath).catch(() => {})
          }
          return
        }
        speechAdmission.commitListener(owner, sessionListener)
        if (resolvedHotwordsPath) {
          unlink(resolvedHotwordsPath).catch(() => {})
        }
      } catch (err) {
        cleanupSessionListener()
        if (resolvedHotwordsPath) {
          unlink(resolvedHotwordsPath).catch(() => {})
        }
        throw err
      } finally {
        speechAdmission.releaseStart(owner)
      }
    }
  )

  ipcMain.handle(
    'speech:feedAudio',
    async (_event, buffer: Uint8Array, sampleRate: number, sessionId = 'desktop') => {
      // Why: the preload sends audio as a Buffer to avoid Float32Array data
      // being zeroed out during contextBridge + IPC serialization.
      const audio = decodeSpeechAudioChunk(buffer, sampleRate)
      const validatedSessionId = validateSpeechSessionId(sessionId)
      getSpeechSttService(store).feedAudio(
        audio.samples,
        audio.sampleRate,
        getDesktopOwner(_event.sender.id, validatedSessionId)
      )
    }
  )

  ipcMain.handle('speech:stopDictation', async (_event, sessionId = 'desktop') => {
    const owner = getDesktopOwner(_event.sender.id, validateSpeechSessionId(sessionId))
    try {
      await getSpeechSttService(store).stopDictation(owner)
    } finally {
      speechAdmission.releaseListener(owner)
    }
  })
}
