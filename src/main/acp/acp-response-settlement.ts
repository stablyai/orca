import type { z } from 'zod'
import { AcpAgentError, AcpAuthRequiredError, AcpInvalidResponseError } from './acp-errors'
import type { AcpJsonRpcPeer } from './acp-json-rpc-peer'

export function callAcpSession<T>(
  peer: AcpJsonRpcPeer,
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  answered: ((signedIn: boolean) => void) | undefined
): Promise<T> {
  return peer.request(method, params, {
    timeoutMs: null,
    settle: (response) => {
      if ('error' in response) {
        const error = response.error
        if (error instanceof AcpAgentError && error.code === -32000) {
          answered?.(false)
          throw new AcpAuthRequiredError(error.message, error.data)
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
      return parsed.data
    }
  })
}

export type AcpResponse = { value: unknown } | { error: Error }
export type AcpRequestOptions<T = unknown> = {
  timeoutMs?: number | null
  settle: (response: AcpResponse) => T
}
export type AcpPendingResponse = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export function readAcpResponse(
  response: AcpResponse,
  settle: AcpRequestOptions['settle'] | undefined
): unknown {
  if (settle) {
    return settle(response)
  }
  if ('error' in response) {
    throw response.error
  }
  return response.value
}
