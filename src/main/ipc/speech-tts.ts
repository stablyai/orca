import { ipcMain } from 'electron'
import { cancelEdgeSpeech, synthesizeEdgeSpeech } from '../speech/edge-tts-synthesize'

export function registerSpeechTtsHandlers(): void {
  ipcMain.handle('speech:synthesize', async (_event, request: unknown) =>
    synthesizeEdgeSpeech(request)
  )
  ipcMain.handle('speech:cancelSynthesis', () => {
    cancelEdgeSpeech()
  })
}
