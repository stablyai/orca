import { expect } from 'vitest'
import type { Mock } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'

export function pairingCode(endpoint = 'ws://127.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

/** Resolves the `ipcMain.handle` callback a suite registered for `channel`. */
export function channelHandlerLookup(handleMock: Mock) {
  return function handler<TArgs, TResult>(
    channel: string
  ): (_event: unknown, args: TArgs) => TResult | Promise<TResult> {
    const match = handleMock.mock.calls.find((call) => call[0] === channel)
    expect(match).toBeTruthy()
    return match![1] as (_event: unknown, args: TArgs) => TResult | Promise<TResult>
  }
}
