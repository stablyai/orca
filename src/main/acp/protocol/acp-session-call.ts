import type { z } from 'zod'
import {
  AcpAgentError,
  AcpInvalidResponseError,
  acpAuthRequiredError
} from '../transport/acp-errors'

import type { AcpJsonRpcPeer } from '../transport/acp-json-rpc-peer'
import type { AcpResponse } from '../transport/acp-response-settlement'

/** Reads a session call's answer: auth refusals, schema check, and the sign-in answer. */
export function settleAcpSessionCall<T>(
  method: string,
  schema: z.ZodType<T>,
  answered: ((signedIn: boolean) => void) | undefined,
  received?: (response: T) => void
): (response: AcpResponse) => T {
  return (response) => {
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
}

export function callAcpSession<T>(
  peer: AcpJsonRpcPeer,
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  answered: ((signedIn: boolean) => void) | undefined,
  received?: (response: T) => void,
  timeoutMs: number | null = null,
  onId?: (id: number) => void
): Promise<T> {
  return peer.request(method, params, {
    timeoutMs,
    ...(onId ? { onId } : {}),
    // A bounded session control fails only itself; the agent is asked to drop it.
    ...(timeoutMs === null ? {} : { onTimeout: 'cancel' as const }),
    settle: settleAcpSessionCall(method, schema, answered, received)
  })
}
