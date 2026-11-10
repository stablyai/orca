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
let connected: boolean | undefined

function publishConnection(next: boolean): void {
  if (connected === next) {
    return
  }
  connected = next
  if (!next) {
    const previous = connection
    connection = undefined
    connecting = undefined
    const attempt = pendingPort
    pendingPort = undefined
    previous?.close()
    attempt?.reject(new Error('Usage disconnected. Try again after it reconnects.'))
  }
  for (const listener of connectionListeners) {
    listener(next)
  }
}

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
  const previous = connection
  connection = undefined
  previous?.close()
  const client = new BackendPortRpc(
    adapter,
    'renderer',
    async () => {
      throw new Error('Renderer capabilities are not available on this port.')
    },
    () => {
      if (connection === client) {
        publishConnection(false)
      }
    }
  )
  connection = client
  const attempt = pendingPort
  pendingPort = undefined
  attempt.resolve(client)
  publishConnection(true)
})

function connect(): Promise<BackendPortRpc> {
  if (connection) {
    return Promise.resolve(connection)
  }
  if (connecting) {
    return connecting
  }
  const attemptPromise = new Promise<BackendPortRpc>((resolve, reject) => {
    const attempt = { token: crypto.randomUUID(), resolve, reject }
    pendingPort = attempt
    void ipcRenderer.invoke(BACKEND_PORT_REQUEST, attempt.token).catch((error: Error) => {
      if (pendingPort === attempt) {
        pendingPort.reject(error)
        pendingPort = undefined
      }
    })
  })
  const result = attemptPromise.finally(() => {
    if (connecting === result) {
      connecting = undefined
    }
  })
  connecting = result
  return result
}

ipcRenderer.on(BACKEND_CONNECTION_CHANGED, (_event, state: { connected: boolean }) => {
  publishConnection(state.connected)
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
