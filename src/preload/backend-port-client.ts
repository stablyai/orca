import { ipcRenderer } from 'electron'
import { BackendPortRpc, type BackendPort } from '../shared/backend-port-rpc'
import {
  BACKEND_CONNECTION_CHANGED,
  BACKEND_PORT_DELIVERY,
  BACKEND_PORT_REQUEST,
  type BackendConnectionPurpose,
  type BackendConnectionStatus,
  type BackendConnectionListener
} from '../shared/backend-service-contract'

let connection: BackendPortRpc | undefined
let connecting: Promise<BackendPortRpc> | undefined
type PortAttempt = {
  token: string
  purpose: BackendConnectionPurpose
  resolve(client: BackendPortRpc): void
  reject(error: Error): void
}
let pendingPort: PortAttempt | undefined
const connectionListeners = new Set<BackendConnectionListener>()
let connected: boolean | undefined
let unavailable = false

function publishConnection(next: boolean): void {
  if (next) {
    unavailable = false
  }
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

function requestPort(attempt: PortAttempt): void {
  void ipcRenderer
    .invoke(BACKEND_PORT_REQUEST, attempt.token, attempt.purpose)
    .catch((error: Error) => {
      if (pendingPort === attempt) {
        pendingPort = undefined
        attempt.reject(error)
      }
    })
}

function connect(purpose: BackendConnectionPurpose = 'demand'): Promise<BackendPortRpc> {
  if (connection) {
    return Promise.resolve(connection)
  }
  if (connecting) {
    if (purpose === 'demand' && pendingPort?.purpose === 'recovery') {
      pendingPort = { ...pendingPort, token: crypto.randomUUID(), purpose }
      requestPort(pendingPort)
    }
    return connecting
  }
  const attemptPromise = new Promise<BackendPortRpc>((resolve, reject) => {
    const attempt = { token: crypto.randomUUID(), purpose, resolve, reject }
    pendingPort = attempt
    requestPort(attempt)
  })
  const result = attemptPromise.finally(() => {
    if (connecting === result) {
      connecting = undefined
    }
  })
  connecting = result
  return result
}

ipcRenderer.on(BACKEND_CONNECTION_CHANGED, (_event, state: BackendConnectionStatus) => {
  publishConnection(state.connected)
  if (!state.connected && state.unavailable && !unavailable) {
    unavailable = true
    for (const listener of connectionListeners) {
      listener(false, { unavailable: true })
    }
  }
})

export const backendUsageTransport = {
  onConnectionChanged(listener: BackendConnectionListener): () => void {
    connectionListeners.add(listener)
    listener(connected ?? false, { initial: true, unavailable })
    return () => {
      connectionListeners.delete(listener)
    }
  },
  invoke: async (
    method: string,
    params?: unknown,
    purpose?: BackendConnectionPurpose
  ): Promise<unknown> => (await connect(purpose)).call(method, params)
}
