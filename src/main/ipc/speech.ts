import { ipcMain, BrowserWindow, systemPreferences, app } from 'electron'
import { join } from 'path'
import { writeFile, unlink } from 'fs/promises'
import { createHash } from 'crypto'
import { SPEECH_MODEL_CATALOG, getCatalogModel } from '../speech/model-catalog'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import type { Store } from '../persistence'

export function registerSpeechHandlers(store: Store): void {
  ipcMain.handle('speech:getCatalog', () => {
    return SPEECH_MODEL_CATALOG
  })

  ipcMain.handle('speech:getModelStates', async () => {
    return getSpeechModelManager(store).getModelStates()
  })

  ipcMain.handle('speech:downloadModel', async (event, modelId: string) => {
    const manager = getSpeechModelManager(store)
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
    getSpeechModelManager(store).cancelDownload(modelId)
  })

  ipcMain.handle('speech:deleteModel', async (_event, modelId: string) => {
    if (!getCatalogModel(modelId)) {
      throw new Error(`Unknown model: ${modelId}`)
    }
    await getSpeechModelManager(store).deleteModel(modelId)
  })

  const getHotwordsFilePath = (content: string): string => {
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
    return join(app.getPath('userData'), `speech-hotwords-${digest}.txt`)
  }

  ipcMain.handle('speech:startDictation', async (event, modelId: string, hotwords?: string[]) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return
    }
    let resolvedHotwordsPath: string | undefined
    const cleanupOnWindowClosed = (): void => {
      void getSpeechSttService(store)
        .stopDictation('desktop')
        .finally(() => {
          if (resolvedHotwordsPath) {
            unlink(resolvedHotwordsPath).catch(() => {})
          }
        })
    }
    window.once('closed', cleanupOnWindowClosed)

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

    if (hotwords && hotwords.length > 0) {
      const content = `${hotwords.map((w) => `${w} :2.0`).join('\n')}\n`
      const hotwordsFilePath = getHotwordsFilePath(content)
      await writeFile(hotwordsFilePath, content, 'utf-8')
      resolvedHotwordsPath = hotwordsFilePath
    }

    try {
      await getSpeechSttService(store).startDictation(
        modelId,
        (msg) => {
          if (window.isDestroyed()) {
            return
          }
          switch (msg.type) {
            case 'ready':
              window.webContents.send('speech:ready')
              break
            case 'partial':
              window.webContents.send('speech:partial', msg.text)
              break
            case 'final':
              window.webContents.send('speech:final', msg.text)
              break
            case 'stopped':
              window.webContents.send('speech:stopped')
              break
            case 'error':
              window.webContents.send('speech:error', msg.error)
              break
          }
        },
        resolvedHotwordsPath,
        'desktop'
      )
      if (resolvedHotwordsPath) {
        unlink(resolvedHotwordsPath).catch(() => {})
      }
    } catch (err) {
      window.off('closed', cleanupOnWindowClosed)
      if (resolvedHotwordsPath) {
        unlink(resolvedHotwordsPath).catch(() => {})
      }
      throw err
    }
  })

  ipcMain.handle('speech:feedAudio', async (_event, buffer: Buffer, sampleRate: number) => {
    // Why: the preload sends audio as a Buffer to avoid Float32Array data
    // being zeroed out during contextBridge + IPC serialization.
    const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
    getSpeechSttService(store).feedAudio(samples, sampleRate, 'desktop')
  })

  ipcMain.handle('speech:stopDictation', async () => {
    await getSpeechSttService(store).stopDictation('desktop')
  })
}
