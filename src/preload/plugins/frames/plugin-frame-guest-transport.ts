/** Why written out: the sandboxed preload can't load shared chunks; the test pins these to
 *  plugin-frame-guest.ts. */
export const PRELOAD_PLUGIN_FRAME_IPC_CHANNEL = 'orca-plugin-frame'
export const PRELOAD_PLUGIN_FRAME_TRANSPORT_GLOBAL = '__orcaPluginFrameTransport'
export const PRELOAD_PLUGIN_FRAME_KEY_CHANNEL = 'orca-plugin-frame-key'

/**
 * Runs serialized in the guest's main world, so it must not reference anything outside its body.
 * Hands Orca's injected frame shell its transport; the shell deletes the property before any
 * plugin script runs, and only one subscriber ever receives host messages.
 */
export function installPluginFrameTransport(
  name: string,
  send: (message: unknown) => void,
  subscribe: (receive: (message: unknown) => void) => void
): void {
  let subscribed = false
  const transport = Object.freeze({
    send: (message: unknown): void => send(message),
    subscribe: (receive: (message: unknown) => void): void => {
      if (subscribed || typeof receive !== 'function') {
        return
      }
      subscribed = true
      subscribe(receive)
    }
  })
  Object.defineProperty(window, name, {
    value: transport,
    configurable: true,
    enumerable: false,
    writable: false
  })
}
