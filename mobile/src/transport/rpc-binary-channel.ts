import type { RpcClient } from './rpc-client'

/** A dedicated physical connection; terminal and screencast subscriptions stay elsewhere. */
export type RpcBinaryChannelOptions = {
  claimQueuedBytes?: (bytes: number) => (() => void) | null
  clientCapabilities?: readonly string[]
  onBinary: (bytes: Uint8Array) => void
}

export type RpcBinaryClient = RpcClient & {
  sendBinary: (bytes: Uint8Array) => boolean
}

export function requireBinarySubscription(method: string, enabled = true): void {
  if (enabled && method !== 'network.browserTunnel') {
    throw new Error('Dedicated browser connection cannot carry other subscriptions')
  }
}
