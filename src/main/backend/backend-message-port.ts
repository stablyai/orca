import type { BackendPort } from '../../shared/backend-port-rpc'

export type BackendNativePort = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  off(event: 'message', listener: (event: { data: unknown }) => void): unknown
  off(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

export function backendMessagePort(port: BackendNativePort): BackendPort {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      const receive = (event: { data: unknown }): void => listener(event.data)
      port.on('message', receive)
      port.start()
      return () => {
        port.off('message', receive)
      }
    },
    onClose(listener) {
      port.on('close', listener)
      return () => {
        port.off('close', listener)
      }
    },
    close: () => port.close()
  }
}
