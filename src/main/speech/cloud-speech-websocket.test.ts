import { describe, expect, it, vi } from 'vitest'

const { constructed } = vi.hoisted(() => {
  const calls: unknown[][] = []
  return { constructed: calls }
})

vi.mock('ws', () => ({
  default: class {
    constructor(...args: unknown[]) {
      constructed.push(args)
    }
  }
}))

import {
  openProviderWebSocket,
  PROVIDER_HANDSHAKE_TIMEOUT_MS,
  PROVIDER_MAX_PAYLOAD_BYTES
} from './cloud-speech-websocket'

describe('openProviderWebSocket', () => {
  it('bounds the handshake and inbound frame size', () => {
    openProviderWebSocket('wss://example.test', { Authorization: 'Token k' })

    expect(constructed.at(-1)).toEqual([
      'wss://example.test',
      {
        handshakeTimeout: PROVIDER_HANDSHAKE_TIMEOUT_MS,
        maxPayload: PROVIDER_MAX_PAYLOAD_BYTES,
        headers: { Authorization: 'Token k' }
      }
    ])
  })
})
