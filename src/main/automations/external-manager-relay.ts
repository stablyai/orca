import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'

export function requireExternalAutomationMultiplexer(
  connectionId: string
): NonNullable<ReturnType<typeof getActiveMultiplexer>> {
  const mux = getActiveMultiplexer(connectionId)
  if (!mux || mux.isDisposed()) {
    throw new Error(`SSH target "${connectionId}" is not connected.`)
  }
  return mux
}

/**
 * True only for a structured JSON-RPC `-32601`, never for error prose.
 *
 * A `-32601` object means the peer parsed the request and declined the method,
 * so it is positive evidence the connection is healthy. Matching the words
 * "method not found" instead would let a genuinely broken relay be reported as
 * a missing capability, hiding a dead connection behind a capability notice.
 */
export function isRelayMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === JsonRpcErrorCode.MethodNotFound
  )
}

export function externalAutomationRelayErrorMessage(error: unknown): string {
  if (isRelayMethodNotFoundError(error)) {
    return 'Remote relay does not support external automation management. Reconnect the SSH target to deploy the latest relay.'
  }
  return error instanceof Error ? error.message : String(error)
}
