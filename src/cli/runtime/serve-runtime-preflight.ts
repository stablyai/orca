import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { RuntimeClientError } from './types'

export const SERVE_RUNTIME_PROBE_TIMEOUT_MS = 250

function systemCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

function refusal(reason: string, code?: string): RuntimeClientError {
  const permissionDenied = code === 'EPERM' || code === 'EACCES'
  const message =
    reason === 'endpoint_accepting'
      ? 'The published runtime endpoint accepts connections. Refusing to start another Orca process for this profile.'
      : 'Cannot verify whether this profile can start an Orca runtime. Refusing to launch another process.'
  return new RuntimeClientError(
    permissionDenied ? 'runtime_permission_denied' : 'runtime_serve_refused',
    message,
    {
      reason: permissionDenied ? 'permission_denied' : reason,
      systemCode: code,
      processState: 'unverifiable',
      nextSteps: [
        'Check Orca status and access permissions from the host that owns this profile. Do not automatically retry serve.'
      ]
    }
  )
}

function localEndpoint(metadata: unknown): string | undefined {
  if (metadata === null || typeof metadata !== 'object') {
    return undefined
  }
  const transports: unknown[] =
    'transports' in metadata && Array.isArray(metadata.transports)
      ? metadata.transports
      : 'transport' in metadata
        ? [metadata.transport]
        : []
  for (const transport of transports) {
    if (transport === null || typeof transport !== 'object' || !('kind' in transport)) {
      continue
    }
    if (transport.kind !== 'unix' && transport.kind !== 'named-pipe') {
      continue
    }
    return 'endpoint' in transport &&
      typeof transport.endpoint === 'string' &&
      transport.endpoint.trim().length > 0
      ? transport.endpoint
      : undefined
  }
  return undefined
}

// Existing discovery readers discard read/parse errors; a launch decision must preserve them.
export function preflightServeRuntime(
  userDataPath: string
): Promise<RuntimeClientError | null> | null {
  let contents: string
  try {
    contents = readFileSync(getRuntimeMetadataPath(userDataPath), 'utf8')
  } catch (error) {
    const code = systemCode(error)
    return code === 'ENOENT' ? null : Promise.resolve(refusal('read_metadata_failed', code))
  }
  let endpoint: string | undefined
  try {
    endpoint = localEndpoint(JSON.parse(contents))
  } catch {
    return Promise.resolve(refusal('invalid_metadata'))
  }
  if (!endpoint) {
    return Promise.resolve(refusal('invalid_metadata'))
  }

  return new Promise((resolve) => {
    let socket: ReturnType<typeof createConnection>
    try {
      socket = createConnection({ path: endpoint })
    } catch (error) {
      resolve(refusal('connect_failed', systemCode(error)))
      return
    }
    let settled = false
    const finish = (error: RuntimeClientError | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(error)
    }
    const timer = setTimeout(() => finish(refusal('timeout')), SERVE_RUNTIME_PROBE_TIMEOUT_MS)
    socket.once('connect', () => finish(refusal('endpoint_accepting')))
    // Keep the listener through destroy: late errors must not terminate the CLI.
    socket.on('error', (error: unknown) => {
      const code = systemCode(error)
      finish(code === 'ENOENT' || code === 'ECONNREFUSED' ? null : refusal('connect_failed', code))
    })
    socket.once('close', () => finish(refusal('connection_closed')))
  })
}
