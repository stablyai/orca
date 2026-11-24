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
import type { AcpJsonRpcPeer, AcpRequestContext } from '../transport/acp-json-rpc-peer'
import { answerAcpPermission, readAcpPermissionRequest } from './acp-permission-requests'
import { readAcpSessionEvent, type AcpSessionEvent } from './acp-session-events'
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
  timeoutMs: number | null = null,
  rejected?: (error: unknown) => void
): Promise<T> {
  return peer.request(method, params, {
    timeoutMs,
    // A bounded session control fails only itself; the agent is asked to drop it.
    ...(timeoutMs === null ? {} : { onTimeout: 'cancel' as const }),
    settle: (response) => {
      if ('error' in response) {
        const error = response.error
        const mapped =
          error instanceof AcpAgentError && error.code === -32000
            ? (answered?.(false), acpAuthRequiredError(error))
            : error
        rejected?.(mapped)
        throw mapped
      }
      const parsed = schema.safeParse(response.value)
      if (!parsed.success) {
        const invalid = new AcpInvalidResponseError(
          `Invalid ACP response: ${method}`,
          response.value,
          parsed.error.issues
        )
        rejected?.(invalid)
        throw invalid
      }
      if (['session/new', 'session/load', 'session/resume'].includes(method)) {
        answered?.(true)
      }
      received?.(parsed.data)
      return parsed.data
    }
  })
}

export function handleAcpSessionRequest(
  method: string,
  params: unknown,
  context: AcpRequestContext,
  startedSessionId: string | undefined,
  options: Pick<AcpSessionRuntimeOptions, 'onRequest' | 'onPermission'>,
  diagnose: (message: string) => void
): unknown {
  if (method !== 'session/request_permission') {
    if (!options.onRequest) {
      throw new AcpRpcError(-32601, `Unknown ACP client method: ${method}`)
    }
    return options.onRequest(method, params, context)
  }
  const request = readAcpPermissionRequest(params, diagnose)
  if (!request) {
    throw new AcpRpcError(-32602, 'Invalid ACP permission request')
  }
  // Only the started session asks the caller; the caller decides who can answer.
  if (request.sessionId !== startedSessionId) {
    return { outcome: { outcome: 'cancelled' } }
  }
  return answerAcpPermission(request, context, options.onPermission, diagnose)
}

export function dispatchAcpSessionNotification(
  method: string,
  params: unknown,
  listeners: ReadonlySet<(event: AcpSessionEvent) => void>,
  onExtension: AcpSessionRuntimeOptions['onExtensionNotification'],
  diagnose: (message: string) => void,
  reportUnrecognized: () => boolean
): void {
  if (method !== 'session/update') {
    try {
      onExtension?.(method, params)
    } catch (error) {
      diagnose(`ACP extension listener failed: ${String(error)}`)
    }
    return
  }
  const event = readAcpSessionEvent(params)
  if (!event) {
    diagnose('Ignored invalid ACP session update envelope')
    return
  }
  if (event.kind === 'unrecognized' && reportUnrecognized()) {
    diagnose('Forwarded unrecognized ACP session update')
  }
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      diagnose(`ACP event listener failed: ${String(error)}`)
    }
  }
}
