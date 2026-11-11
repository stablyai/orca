import type { z } from 'zod'
import {
  AcpAgentError,
  AcpInvalidResponseError,
  acpAuthRequiredError
} from '../transport/acp-errors'

import type { AcpJsonRpcPeer } from '../transport/acp-json-rpc-peer'

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
