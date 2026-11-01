import { describe, expect, it } from 'vitest'

import {
  renderServeReadiness,
  ServeReadinessPublisher,
  type ServeReadiness
} from './serve-readiness'

const ready: ServeReadiness = {
  runtimeId: 'runtime-1',
  boundEndpoint: 'ws://0.0.0.0:6768',
  advertisedEndpoint: 'wss://orca.example.test/runtime',
  managedWslCliReconciliation: 'settled',
  pairing: {
    available: true,
    url: 'orca://pair?code=secret',
    endpoint: 'wss://orca.example.test/runtime',
    deviceId: 'device-1',
    webClientUrl: 'https://orca.example.test/runtime/web-index.html#pairing=secret',
    scope: 'runtime',
    qr: null
  }
}

describe('ServeReadinessPublisher', () => {
  it('fails recipe output with the unavailable reason and guidance', () => {
    const unavailable: ServeReadiness = {
      ...ready,
      pairing: {
        available: false,
        reason: 'websocket_unavailable',
        guidance: 'Choose an unused --port.'
      }
    }
    expect(() =>
      renderServeReadiness(unavailable, { mode: 'recipe-json', projectRoot: '/workspace' })
    ).toThrow('websocket_unavailable. Choose an unused --port.')
  })

  it('rejects concurrent and later duplicate publications', async () => {
    let finishWrite: (() => void) | undefined
    const publisher = new ServeReadinessPublisher(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    const first = publisher.publish(ready, { mode: 'json' })

    await expect(publisher.publish(ready, { mode: 'json' })).rejects.toThrow(
      'publication already publishing'
    )
    finishWrite?.()
    await first
    await expect(publisher.publish(ready, { mode: 'json' })).rejects.toThrow(
      'publication already published'
    )
  })

  it('surfaces write failures and does not retry a partial contract', async () => {
    const publisher = new ServeReadinessPublisher(async () => {
      throw new Error('stdout closed')
    })

    await expect(publisher.publish(ready, { mode: 'human' })).rejects.toThrow('stdout closed')
    await expect(publisher.publish(ready, { mode: 'human' })).rejects.toThrow(
      'publication already failed'
    )
  })
})
