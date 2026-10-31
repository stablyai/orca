import type { BridgeRpcClientOptions } from './bridge-rpc-client'

// Expose only postMessage/onmessage, the common surface of Android’s injected listener and Swift’s document-start installer; the page cannot address the wider WebView.
export type OrcaBridgePageChannel = {
  postMessage: (json: string) => void
  onmessage: ((event: { data: string }) => void) | null
}

// No channel is valid in a browser or bridge-disabled WebView; let the caller substitute rather than throw.
export function readOrcaBridgePageChannel(): OrcaBridgePageChannel | null {
  const scope: typeof globalThis & { orcaBridge?: OrcaBridgePageChannel } = globalThis
  const channel = scope.orcaBridge
  if (channel === undefined || typeof channel.postMessage !== 'function') {
    return null
  }
  return channel
}

// One onmessage slot requires one page client; a second would silently steal the first client’s frames.
export function createOrcaBridgePageTransport(
  channel: OrcaBridgePageChannel,
  readCurrent: () => OrcaBridgePageChannel | null = () => channel
): Pick<BridgeRpcClientOptions, 'send' | 'onMessage'> {
  let handler: ((json: string) => void) | null = null
  let binding: {
    channel: OrcaBridgePageChannel
    receive: NonNullable<OrcaBridgePageChannel['onmessage']>
  } | null = null

  function detach(): void {
    if (binding !== null && binding.channel.onmessage === binding.receive) {
      binding.channel.onmessage = null
    }
    binding = null
  }

  function bind(current: OrcaBridgePageChannel | null): void {
    if (binding?.channel === current) {
      return
    }
    detach()
    if (current === null || handler === null) {
      return
    }
    const receive = (event: { data: string }): void => {
      if (binding?.receive === receive && readCurrent() === current) {
        handler?.(event.data)
      }
    }
    binding = { channel: current, receive }
    current.onmessage = receive
  }

  return {
    send: (json) => {
      const current = readCurrent()
      bind(current)
      if (current === null) {
        throw new Error('the native bridge channel is unavailable')
      }
      current.postMessage(json)
    },
    onMessage: (received) => {
      handler = received
      bind(readCurrent())
      return () => {
        if (handler === received) {
          handler = null
          detach()
        }
      }
    }
  }
}
