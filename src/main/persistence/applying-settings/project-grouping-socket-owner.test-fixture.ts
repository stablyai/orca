import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { UiUpdateFields } from '../../../shared/rpc-contract/client-ui-params'
import {
  tolerateUnknownValues,
  omitUndefinedValues
} from '../../../shared/rpc-contract/ui-update-value-tolerance-params'
import { createStore, closeTestStores, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../runtime/runtime-rpc'
import { DeviceRegistry } from '../../runtime/device-registry'
import {
  MobileSocketWiring,
  type MobileSocketTransport
} from '../../runtime/rpc/mobile-socket-wiring'
import { CLIENT_UI_METHODS } from '../../runtime/rpc/methods/client-ui'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from '../../runtime/rpc/methods/runtime-client-capabilities'
import { STATUS_METHODS } from '../../runtime/rpc/methods/status'
import { PAIRING_METHODS } from '../../runtime/rpc/methods/pairing'
import { generateKeyPair } from '../../../shared/e2ee-crypto'

/** Real encrypted owner; only delivery may be delayed or an old peer response substituted. */
export async function createProjectGroupingSocketOwner(
  options: {
    deliver?: (method: string, response: string, reply: (response: string) => void) => void
    strictOld?: boolean
    response?: (method: string, response: string) => string
    deviceScope?: 'mobile' | 'runtime'
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-grouping-peer-'))
  testState.dir = directory
  const store = createStore()
  const runtime = new OrcaRuntimeService(store)
  // The released strict wrapper predates the request-only marker; field toleration is identical.
  const oldUpdate = z
    .object(tolerateUnknownValues(UiUpdateFields.shape))
    .strict()
    .default({})
    .transform(omitUndefinedValues)
  const methods = CLIENT_UI_METHODS.map((method) =>
    options.strictOld && method.name === 'ui.set' ? { ...method, params: oldUpdate } : method
  )
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: directory,
    methods: [
      ...methods,
      ...STATUS_METHODS,
      ...PAIRING_METHODS,
      ...RUNTIME_CLIENT_CAPABILITY_METHODS
    ],
    enableWebSocket: false
  })
  const registry = new DeviceRegistry(directory)
  server['deviceRegistry'] = registry
  const device = registry.addDevice('Fixture paired client', options.deviceScope ?? 'runtime')
  const desktop = generateKeyPair()
  const publicKeyB64 = Buffer.from(desktop.publicKey).toString('base64')
  const requests: { method: string; params?: unknown }[] = []
  const auth: { capabilities: string[]; deviceId: string }[] = []
  const wiring = new MobileSocketWiring({
    deviceRegistry: registry,
    e2eeKeypair: { ...desktop, publicKeyB64 },
    onReady: (socket) =>
      auth.push({ capabilities: [...socket.clientCapabilities], deviceId: socket.device.deviceId }),
    onText: (socket, message, reply) => {
      const request = JSON.parse(message)
      requests.push(request)
      void server['handleWebSocketMessage'](
        message,
        (response) => {
          const result = options.response?.(request.method, response) ?? response
          if (options.deliver) {
            options.deliver(request.method, result, reply)
          } else {
            reply(result)
          }
        },
        () => {},
        undefined,
        socket.ws,
        socket.device.deviceToken,
        socket
      )
    },
    onBinary: () => {},
    onClose: () => {}
  })
  let receive: Parameters<MobileSocketTransport['onMessage']>[0] = () => {}
  let closed: Parameters<MobileSocketTransport['onConnectionClose']>[0] = () => {}
  wiring.attachTransport({
    onMessage: (callback) => {
      receive = callback
    },
    onConnectionClose: (callback) => {
      closed = callback
    },
    setClientId: () => {},
    terminateClientConnections: () => 0
  })
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  wss.on('connection', (ws) => {
    ws.on('message', (bytes) => receive(bytes.toString(), (response) => ws.send(response), ws))
    ws.on('close', () => closed(null, ws, false))
  })
  const address = wss.address()
  if (!address || typeof address === 'string') {
    throw new Error('No fixture listener')
  }
  const environment = {
    id: 'owner',
    name: 'Desktop',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws-owner',
    sessionOnly: true as const,
    endpoints: [
      {
        id: 'ws-owner',
        kind: 'websocket' as const,
        label: 'WebSocket',
        endpoint: `ws://127.0.0.1:${address.port}`,
        deviceToken: device.token,
        publicKeyB64
      }
    ]
  }
  return {
    store,
    directory,
    runtime,
    server,
    registry,
    device,
    environment,
    requests,
    auth,
    close: async () => {
      for (const socket of wss.clients) {
        socket.close()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      wiring.dispose()
      await closeTestStores()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
