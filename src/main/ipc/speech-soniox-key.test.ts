import { describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../speech/soniox-api-key-store', () => ({
  hasSonioxSpeechApiKey: async () => true,
  getSonioxSpeechApiKeyProtection: async () => 'plaintext',
  clearSonioxSpeechApiKey: async () => undefined
}))
vi.mock('../speech/soniox-key-verification', () => ({
  saveVerifiedSonioxSpeechApiKey: async () => undefined
}))

import { registerSonioxSpeechKeyHandlers } from './speech-soniox-key'

describe('Soniox key IPC', () => {
  it('answers status and save with plain values Electron can clone', async () => {
    registerSonioxSpeechKeyHandlers()
    // A Promise in the reply fails structured clone, which hid the unsealed-key notice.
    await expect(handlers.get('speech:getSonioxApiKeyStatus')!({})).resolves.toEqual({
      configured: true,
      protection: 'plaintext'
    })
    await expect(handlers.get('speech:saveSonioxApiKey')!({}, 'key')).resolves.toEqual({
      configured: true,
      protection: 'plaintext'
    })
  })
})
