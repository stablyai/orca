import type { z } from 'zod'
import {
  AcpAgentError,
  AcpInvalidResponseError,
  AcpRpcError,
  acpAuthRequiredError
} from '../transport/acp-errors'
import type { AcpJsonRpcPeer, AcpRequestContext } from '../transport/acp-json-rpc-peer'
import type { AcpResponse } from '../transport/acp-response-settlement'
import { answerAcpPermission, readAcpPermissionRequest } from './acp-permission-requests'
import { readAcpSessionEvent, type AcpSessionEvent } from './acp-session-events'
import type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'

export type AcpSessionCallOptions = {
  onId?: (id: number) => void
  rejected?: (error: unknown) => void
}

/** Reads a session call's answer: auth refusals, schema check, and the sign-in answer. */
export function settleAcpSessionCall<T>(
  method: string,
  schema: z.ZodType<T>,
  answered: ((signedIn: boolean) => void) | undefined,
  received?: (response: T) => void,
  rejected?: (error: unknown) => void
): (response: AcpResponse) => T {
  return (response) => {
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
}

export function callAcpSession<T>(
  peer: AcpJsonRpcPeer,
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  answered: ((signedIn: boolean) => void) | undefined,
  received?: (response: T) => void,
  timeoutMs: number | null = null,
  options?: AcpSessionCallOptions
): Promise<T> {
  return peer.request(method, params, {
    timeoutMs,
    ...(options?.onId ? { onId: options.onId } : {}),
    // A bounded session control fails only itself; the agent is asked to drop it.
    ...(timeoutMs === null ? {} : { onTimeout: 'cancel' as const }),
    settle: settleAcpSessionCall(method, schema, answered, received, options?.rejected)
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
