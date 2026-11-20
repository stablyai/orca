import '../app-registry/testing/app-ipc-test-host'
import { expect, it, vi } from 'vitest'

const { handlers, clearKey, clearProvider, readProvider } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  clearKey: vi.fn<() => Promise<void>>(),
  clearProvider: vi.fn<() => Promise<void>>(),
  readProvider: vi.fn<() => Promise<null>>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('../../speech/openai-api-key-store', () => ({
  hasOpenAiSpeechApiKey: async () => true,
  getOpenAiSpeechApiKeyProtection: async () => 'encrypted',
  clearOpenAiSpeechApiKey: clearKey
}))
vi.mock('../../speech/openai-compatible-speech-provider-store', () => ({
  summarizeOpenAiCompatibleSpeechProvider: readProvider,
  clearOpenAiCompatibleSpeechProvider: clearProvider
}))

import { registerSpeechApplicationHandlers } from './speech-application-handlers'

it('returns cloneable credential status and joins persisted clears before success', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: credential handlers do not use the store or transcriber.
  registerSpeechApplicationHandlers({} as never, undefined, () => {
    throw new Error('unused')
  })
  const status = await handlers.get('speech:getOpenAiApiKeyStatus')!({})
  expect(structuredClone(status)).toEqual({ configured: true, protection: 'encrypted' })
  readProvider.mockRejectedValueOnce(new Error('unreadable credential'))
  await expect(handlers.get('speech:getOpenAiCompatibleProvider')!({})).resolves.toBeNull()

  for (const [channel, clear] of [
    ['speech:clearOpenAiApiKey', clearKey],
    ['speech:clearOpenAiCompatibleProvider', clearProvider]
  ] as const) {
    const persisted = Promise.withResolvers<void>()
    clear.mockReturnValueOnce(persisted.promise)
    const result = Promise.resolve(handlers.get(channel)!({}))
    const diskFailure = new Error('credential clear failed')
    persisted.reject(diskFailure)
    await expect(result).rejects.toBe(diskFailure)
  }
})
