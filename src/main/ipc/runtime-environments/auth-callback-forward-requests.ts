// Validates the untrusted IPC payloads that open or close a sign-in callback forward.
import type {
  AuthCallbackForwardRequest,
  LoopbackCallbackForwardRequest
} from '../../../shared/auth-callback-forward'

function field(value: unknown, name: string): unknown {
  return value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined
}

function callbackPortOf(value: unknown): number | null {
  const port = field(value, 'port')
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65_535
    ? port
    : null
}

export function flowOf(
  value: unknown
): Pick<AuthCallbackForwardRequest, 'environmentId' | 'flowId'> | null {
  const environmentId = field(value, 'environmentId')
  const flowId = field(value, 'flowId')
  return typeof environmentId === 'string' && typeof flowId === 'string'
    ? { environmentId, flowId }
    : null
}

export function requestOf(value: unknown): AuthCallbackForwardRequest | null {
  const flow = flowOf(value)
  const port = callbackPortOf(value)
  return flow && port !== null ? { ...flow, port } : null
}

/** An agent's own OAuth callback on the host: no Orca sign-in flow, just the port it listens on. */
export function loopbackRequestOf(value: unknown): LoopbackCallbackForwardRequest | null {
  const environmentId = field(value, 'environmentId')
  const port = callbackPortOf(value)
  return typeof environmentId === 'string' && port !== null ? { environmentId, port } : null
}
