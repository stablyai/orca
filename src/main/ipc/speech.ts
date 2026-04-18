import { ipcMain, BrowserWindow, systemPreferences } from 'electron'
import { ModelManager } from '../speech/model-manager'
import { SttService } from '../speech/stt-service'
import { SPEECH_MODEL_CATALOG } from '../speech/model-catalog'
import type { Store } from '../persistence'

let modelManager: ModelManager | null = null
let sttService: SttService | null = null

function getModelManager(store: Store): ModelManager {
  if (!modelManager) {
    const settings = store.getSettings()
    const customDir = settings.voice?.modelsDir || undefined
    modelManager = new ModelManager(customDir || undefined)
  }
  return modelManager
}

function getSttService(store: Store): SttService {
  if (!sttService) {
    sttService = new SttService(getModelManager(store))
  }
  return sttService
}

export function registerSpeechHandlers(store: Store): void {
  ipcMain.handle('speech:getCatalog', () => {
    return SPEECH_MODEL_CATALOG
  })

  ipcMain.handle('speech:getModelStates', async () => {
    return getModelManager(store).getModelStates()
  })

  ipcMain.handle('speech:downloadModel', async (event, modelId: string) => {
    const manager = getModelManager(store)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return
    }

    manager.setProgressCallback((id, progress) => {
      if (!window.isDestroyed()) {
        window.webContents.send('speech:downloadProgress', { modelId: id, progress })
      }
    })

    await manager.downloadModel(modelId)
  })

  ipcMain.handle('speech:cancelDownload', async (_event, modelId: string) => {
    getModelManager(store).cancelDownload(modelId)
  })

  ipcMain.handle('speech:deleteModel', async (_event, modelId: string) => {
    await getModelManager(store).deleteModel(modelId)
  })

  ipcMain.handle('speech:startDictation', async (event, modelId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return
    }

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

    await getSttService(store).startDictation(modelId, window)
  })

  ipcMain.handle('speech:feedAudio', async (_event, buffer: Buffer, sampleRate: number) => {
    // Why: the preload sends audio as a Buffer to avoid Float32Array data
    // being zeroed out during contextBridge + IPC serialization.
    const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
    getSttService(store).feedAudio(samples, sampleRate)
  })

  ipcMain.handle('speech:stopDictation', async () => {
    await getSttService(store).stopDictation()
  })
}
