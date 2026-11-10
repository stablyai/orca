import { ipcRenderer } from 'electron'
import { BackendPortRpc, type BackendPort } from '../shared/backend-port-rpc'
import {
  BACKEND_CONNECTION_CHANGED,
  BACKEND_PORT_DELIVERY,
  BACKEND_PORT_REQUEST
} from '../shared/backend-service-contract'

let connection: BackendPortRpc | undefined
let connecting: Promise<BackendPortRpc> | undefined
let pendingPort:
  | { token: string; resolve(client: BackendPortRpc): void; reject(error: Error): void }
  | undefined
const connectionListeners = new Set<(connected: boolean) => void>()

ipcRenderer.on(BACKEND_PORT_DELIVERY, (event, data: { token?: string }) => {
  const [port, ...surplus] = event.ports
  for (const extra of surplus) {
    extra.close()
  }
  if (!port || !pendingPort || pendingPort.token !== data?.token) {
    port?.close()
    return
  }
  const adapter: BackendPort = {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      const receive = (event: MessageEvent): void => listener(event.data)
      port.addEventListener('message', receive)
      port.start()
      return () => port.removeEventListener('message', receive)
    },
    onClose(listener) {
      port.addEventListener('close', listener)
      return () => port.removeEventListener('close', listener)
    },
    close: () => port.close()
  }
  connection?.close()
  connection = new BackendPortRpc(
    adapter,
    'renderer',
    async () => {
      throw new Error('Renderer capabilities are not available on this port.')
    },
    () => {
      connection = undefined
    }
  )
  pendingPort.resolve(connection)
  pendingPort = undefined
})

function connect(): Promise<BackendPortRpc> {
  if (connection) {
    return Promise.resolve(connection)
  }
  connecting ??= new Promise<BackendPortRpc>((resolve, reject) => {
    const attempt = { token: crypto.randomUUID(), resolve, reject }
    pendingPort = attempt
    void ipcRenderer.invoke(BACKEND_PORT_REQUEST, attempt.token).catch((error: Error) => {
      if (pendingPort === attempt) {
        pendingPort.reject(error)
        pendingPort = undefined
      }
    })
  }).finally(() => {
    connecting = undefined
  })
  return connecting
}

ipcRenderer.on(BACKEND_CONNECTION_CHANGED, (_event, state: { connected: boolean }) => {
  if (!state.connected) {
    connection?.close()
    connection = undefined
    pendingPort?.reject(new Error('Usage disconnected. Try again after it reconnects.'))
    pendingPort = undefined
  }
  for (const listener of connectionListeners) {
    listener(state.connected)
  }
})

export const backendUsageTransport = {
  onConnectionChanged(listener: (connected: boolean) => void): () => void {
    connectionListeners.add(listener)
    return () => {
      connectionListeners.delete(listener)
    }
  },
  invoke: async (method: string, params?: unknown): Promise<unknown> =>
    (await connect()).call(method, params)
}
