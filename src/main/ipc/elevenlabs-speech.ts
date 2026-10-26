import { ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import { getSpeechSttService } from '../speech/speech-runtime-service'
import {
  clearElevenLabsSpeechApiKey,
  hasElevenLabsSpeechApiKey,
  saveElevenLabsSpeechApiKey
} from '../speech/elevenlabs-api-key-store'
import {
  listElevenLabsVoices,
  synthesizeElevenLabsSpeech,
  validateElevenLabsSpeechRequest
} from '../speech/elevenlabs-speech-client'

export function registerElevenLabsSpeechHandlers(store: Store): void {
  const requests = new Map<string, AbortController>()

  async function run<T>(
    sender: WebContents,
    id: string,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const key = `${sender.id}:${id}`
    if (sender.isDestroyed() || requests.has(key)) {
      throw new Error('elevenlabs_request_busy')
    }
    const owned = [...requests.keys()].filter((entry) => entry.startsWith(`${sender.id}:`))
    if (owned.length >= 2) {
      throw new Error('elevenlabs_request_busy')
    }
    const controller = new AbortController()
    requests.set(key, controller)
    const cancel = () => controller.abort()
    sender.once('destroyed', cancel)
    try {
      return await task(controller.signal)
    } finally {
      sender.off('destroyed', cancel)
      requests.delete(key)
    }
  }

  async function prepareKeyChange(): Promise<void> {
    await getSpeechSttService(store).prepareModelForDeletion('elevenlabs-scribe-v2-realtime')
    for (const controller of requests.values()) {
      controller.abort()
    }
  }

  ipcMain.handle('speech:getElevenLabsApiKeyStatus', () => ({
    configured: hasElevenLabsSpeechApiKey()
  }))
  ipcMain.handle('speech:saveElevenLabsApiKey', async (_event, key: unknown) => {
    await prepareKeyChange()
    saveElevenLabsSpeechApiKey(key)
    return { configured: true }
  })
  ipcMain.handle('speech:clearElevenLabsApiKey', async () => {
    await prepareKeyChange()
    clearElevenLabsSpeechApiKey()
    return { configured: false }
  })
  ipcMain.handle('speech:listElevenLabsVoices', (event) =>
    run(event.sender, 'voices', listElevenLabsVoices)
  )
  ipcMain.handle('speech:synthesizeElevenLabs', (event, value: unknown) => {
    const input = validateElevenLabsSpeechRequest(value)
    return run(event.sender, input.requestId, (signal) => synthesizeElevenLabsSpeech(input, signal))
  })
  ipcMain.handle('speech:streamElevenLabs', (event, value: unknown) => {
    const input = validateElevenLabsSpeechRequest(value)
    return run(event.sender, input.requestId, async (signal) => {
      await synthesizeElevenLabsSpeech(input, signal, (bytes) => {
        if (!signal.aborted && !event.sender.isDestroyed()) {
          event.sender.send('speech:elevenLabsAudio', { requestId: input.requestId, bytes })
        }
      })
    })
  })
  ipcMain.handle('speech:cancelElevenLabs', (event, id: unknown) => {
    if (typeof id === 'string') {
      requests.get(`${event.sender.id}:${id}`)?.abort()
    }
  })
}
