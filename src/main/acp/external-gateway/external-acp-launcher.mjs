import { mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { createAcpAgentConnection } from '../process/acp-agent-connection'
import { mintGatewayCredential } from './gateway-credential-broker.mjs'
import { startExternalGatewayBridge } from './openai-http-adapter.mjs'
import { AcpRpcError } from '../transport/acp-errors'

const TRANSIENT_NATIVE_ERRORS = new Set([
  'ServerUnavailable',
  'CatalogNotReady',
  'ServiceUnavailableError'
])

function forwardableError(error) {
  const response = {
    code: error instanceof AcpRpcError ? error.code : -32603,
    message: 'External ACP request did not complete'
  }
  const errorName =
    error instanceof AcpRpcError &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'errorName' in error.data &&
    typeof error.data.errorName === 'string' &&
    TRANSIENT_NATIVE_ERRORS.has(error.data.errorName)
      ? error.data.errorName
      : null
  return errorName ? { ...response, data: { errorName } } : response
}

function gatewayCapabilities(params) {
  const capabilities = params.clientCapabilities ?? {}
  const auth = capabilities.auth ?? {}
  return {
    ...params,
    clientCapabilities: {
      ...capabilities,
      auth: { ...auth, _meta: { ...auth._meta, gateway: true } }
    }
  }
}

export async function startExternalAcpLauncher(profile, options = {}) {
  const token =
    options.tokenOverride ?? (await (options.getToken?.() ?? mintGatewayCredential(profile)))
  const bridge = await startExternalGatewayBridge(profile, {
    ...options,
    getToken: async () => token
  })
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const environment = {
    GEMINI_HOME: profile.nativeHome,
    HOME: options.home ?? profile.nativeHome,
    PATH: options.path ?? process.env.PATH ?? '/usr/bin:/bin',
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    AGY_ACP_ENABLE_GATEWAY_AUTH: '1',
    AGY_LLM_GATEWAY_MODELS: profile.modelIds.join(','),
    AGY_ACP_DEFAULT_MODEL: profile.defaultModel,
    PYTHONUNBUFFERED: '1',
    ...(process.platform === 'win32' ? { USERPROFILE: profile.nativeHome } : {})
  }
  let connection
  let closed = false
  let closePromise = null
  let lines
  const clientRequests = new Map()
  const requestKey = (id) => `${typeof id}:${String(id)}`
  const askClient = (id, method, params, signal) =>
    new Promise((resolve, reject) => {
      const key = requestKey(id)
      const cancel = () => {
        signal.removeEventListener('abort', cancel)
        clientRequests.delete(key)
        reject(new AcpRpcError(-32800, 'External ACP client request was canceled'))
      }
      if (closed || signal.aborted) {
        cancel()
        return
      }
      clientRequests.set(key, {
        settle: (error, result) => {
          signal.removeEventListener('abort', cancel)
          clientRequests.delete(key)
          if (error) {
            reject(error)
          } else {
            resolve(result)
          }
        },
        cancel
      })
      signal.addEventListener('abort', cancel, { once: true })
      send({ jsonrpc: '2.0', id, method, params })
    })
  try {
    connection = (options.createConnection ?? createAcpAgentConnection)(
      {
        command: profile.nativeCommand,
        args: [...profile.nativeArgs, ...(process.platform === 'linux' ? ['--uid='] : [])],
        cwd: options.cwd ?? dirname(profile.nativeHome),
        env: environment,
        envToDelete: []
      },
      {
        clientInfo: { name: 'orca', version: '1' },
        clientCapabilities: { auth: { _meta: { gateway: true } } },
        forwardRequestsWithoutSession: true,
        onRequest: (method, params, context) =>
          askClient(context.id, method, params, context.signal)
      }
    )
  } catch (error) {
    await bridge.close()
    throw error
  }
  try {
    await mkdir(join(profile.nativeHome, 'antigravity-acp'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(profile.nativeHome, 'antigravity-acp', 'settings.json'),
      '{"auth":{"type":"gateway"}}',
      { mode: 0o600 }
    )
  } catch (error) {
    closed = true
    await Promise.allSettled([connection.close(), bridge.close()])
    throw error
  }
  const send = (frame) => {
    if (!closed) {
      output.write(`${JSON.stringify(frame)}\n`)
    }
  }
  const close = () => {
    closePromise ??= (async () => {
      closed = true
      lines?.close()
      input.destroy()
      if (!output.writableEnded) {
        output.end()
      }
      for (const request of clientRequests.values()) {
        request.cancel()
      }
      clientRequests.clear()
      await Promise.allSettled([connection.close(), bridge.close()])
    })()
    return closePromise
  }
  connection.onExit(close)
  connection.subscribe((event) => {
    const params = event.kind === 'known' ? event.notification : event.raw
    send({ jsonrpc: '2.0', method: 'session/update', params })
  })
  let authenticating = null
  const forward = async (frame) => {
    try {
      if (frame.method === 'initialize') {
        authenticating ??= (async () => {
          const initialized = await connection.peer.request(
            'initialize',
            gatewayCapabilities(frame.params ?? {})
          )
          await connection.peer.request('authenticate', {
            methodId: 'gateway',
            _meta: {
              gateway: {
                baseUrl: bridge.baseUrl,
                headers: { ...bridge.headers, Authorization: `Bearer ${token}` }
              }
            }
          })
          return initialized
        })()
        send({ jsonrpc: '2.0', id: frame.id, result: await authenticating })
        return
      }
      if (frame.method === 'session/cancel') {
        bridge.abortPending()
        await connection.peer.notify('session/cancel', frame.params ?? {})
        return
      }
      const result = await connection.peer.request(frame.method, frame.params ?? {})
      send({ jsonrpc: '2.0', id: frame.id, result })
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: frame.id,
        error: forwardableError(error)
      })
    }
  }
  lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (line.length > 1_048_576) {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'External ACP frame is too large' }
      })
      return
    }
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'External ACP frame is not JSON' }
      })
      return
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'External ACP frame is not an object' }
      })
      return
    }
    if (
      frame &&
      typeof frame === 'object' &&
      frame.method === undefined &&
      (typeof frame.id === 'string' || typeof frame.id === 'number') &&
      (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'))
    ) {
      const request = clientRequests.get(requestKey(frame.id))
      if (!request) {
        return
      }
      const code = frame.error && Number.isInteger(frame.error.code) ? frame.error.code : -32603
      request.settle(
        frame.error ? new AcpRpcError(code, 'External ACP client rejected the request') : null,
        frame.result
      )
      return
    }
    if (typeof frame.method !== 'string') {
      send({
        jsonrpc: '2.0',
        id: frame.id ?? null,
        error: { code: -32600, message: 'External ACP method is missing' }
      })
      return
    }
    if (frame.id === undefined && frame.method !== 'session/cancel') {
      void connection.peer.notify(frame.method, frame.params ?? {})
      return
    }
    void forward(frame)
  })
  input.on('close', close)
  input.on('end', close)
  input.on('error', close)
  return { close, connection, bridge }
}

export async function runExternalAcpLauncher(profile) {
  const launcher = await startExternalAcpLauncher(profile)
  launcher.connection.onExit((_error, { expected }) => {
    void launcher.close().finally(() => {
      process.exitCode = expected ? 0 : 1
    })
  })
  process.once('SIGINT', () => void launcher.close().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void launcher.close().finally(() => process.exit(0)))
}
