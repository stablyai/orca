import type { z } from 'zod'
import {
  ACP_PROTOCOL_VERSION,
  type InitializeRequest,
  type InitializeResponse,
  type PromptRequest,
  type SetSessionConfigOptionRequest
} from '../generated/acp-protocol.generated'
import {
  AcpAgentError,
  AcpInvalidResponseError,
  AcpRpcError,
  acpAuthRequiredError
} from '../transport/acp-errors'
import type { AcpJsonRpcPeer } from '../transport/acp-json-rpc-peer'
import type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'

type Meta = PromptRequest['_meta']

export function acpWithMeta(meta: Meta): { _meta?: Meta } {
  return meta ? { _meta: meta } : {}
}

export function acpInitializeRequest(
  options: Pick<AcpSessionRuntimeOptions, 'clientCapabilities' | 'clientInfo'>
): InitializeRequest {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      ...options.clientCapabilities
    },
    ...(options.clientInfo === undefined ? {} : { clientInfo: options.clientInfo })
  }
}

export function acpCheckProtocolVersion(
  response: InitializeResponse,
  close: (error: Error) => void
): InitializeResponse {
  if (response.protocolVersion !== ACP_PROTOCOL_VERSION) {
    const error = new AcpRpcError(
      -32602,
      `Unsupported ACP protocol version: ${response.protocolVersion}`
    )
    close(error)
    throw error
  }
  return response
}

export function acpConfigOptionRequest(
  sessionId: string,
  configId: SetSessionConfigOptionRequest['configId'],
  value: SetSessionConfigOptionRequest['value'],
  meta?: Meta
): SetSessionConfigOptionRequest {
  const params = { configId, sessionId, ...acpWithMeta(meta) }
  return typeof value === 'boolean' ? { ...params, value, type: 'boolean' } : { ...params, value }
}

export function callAcpSession<T>(
  peer: AcpJsonRpcPeer,
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  answered: ((signedIn: boolean) => void) | undefined,
  received?: (response: T) => void,
  timeoutMs: number | null = null
): Promise<T> {
  return peer.request(method, params, {
    timeoutMs,
    // A bounded session control fails only itself; the agent is asked to drop it.
    ...(timeoutMs === null ? {} : { onTimeout: 'cancel' as const }),
    settle: (response) => {
      if ('error' in response) {
        const error = response.error
        if (error instanceof AcpAgentError && error.code === -32000) {
          answered?.(false)
          throw acpAuthRequiredError(error)
        }
        throw error
      }
      const parsed = schema.safeParse(response.value)
      if (!parsed.success) {
        throw new AcpInvalidResponseError(
          `Invalid ACP response: ${method}`,
          response.value,
          parsed.error.issues
        )
      }
      if (['session/new', 'session/load', 'session/resume'].includes(method)) {
        answered?.(true)
      }
      received?.(parsed.data)
      return parsed.data
    }
  })
}
