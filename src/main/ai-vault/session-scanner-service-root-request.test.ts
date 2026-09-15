import { afterEach, beforeEach, expect, it } from 'vitest'
import { requestSessionSearchRoots } from './session-scanner-service-root-request'
import {
  isAiVaultServiceChildMessage,
  type AiVaultServiceChildMessage
} from './session-scanner-service-protocol'

let originalSend: typeof process.send
let lastRequest: Extract<AiVaultServiceChildMessage, { type: 'sessionSearchRoots' }>
let listeners: number
beforeEach(() => {
  originalSend = process.send
  listeners = process.listenerCount('message')
  process.send = (message) => {
    if (!isAiVaultServiceChildMessage(message) || message.type !== 'sessionSearchRoots') {
      throw new Error('Unexpected child message')
    }
    lastRequest = message
    return true
  }
})
afterEach(() => {
  process.send = originalSend
  expect(process.listenerCount('message')).toBe(listeners)
})
it('matches the requested snapshot and removes its listener', async () => {
  const pending = requestSessionSearchRoots(new AbortController().signal)
  process.emit(
    'message',
    { type: 'sessionSearchRoots', id: lastRequest.id + 1, roots: {} },
    undefined
  )
  const roots = { additionalCodexSessionsDirs: ['/late'] }
  process.emit('message', { type: 'sessionSearchRoots', id: lastRequest.id, roots }, undefined)
  await expect(pending).resolves.toEqual(roots)
})
it('releases a pending request when indexing is disabled', async () => {
  const controller = new AbortController()
  const pending = requestSessionSearchRoots(controller.signal)
  controller.abort(new Error('disabled'))
  await expect(pending).rejects.toThrow('disabled')
})
it('reports discovery and send failures instead of using stale roots', async () => {
  const pending = requestSessionSearchRoots(new AbortController().signal)
  process.emit(
    'message',
    { type: 'sessionSearchRoots', id: lastRequest.id, roots: null },
    undefined
  )
  await expect(pending).rejects.toThrow('discovery failed')
  process.send = () => {
    throw new Error('channel closed')
  }
  await expect(requestSessionSearchRoots(new AbortController().signal)).rejects.toThrow(
    'channel closed'
  )
})
