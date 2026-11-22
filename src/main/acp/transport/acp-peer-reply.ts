import { z } from 'zod'
import type { AcpPendingResponse } from './acp-response-settlement'
import {
  invalidAcpResponseEnvelope,
  settleAcpResponse,
  type AcpJsonRpcMessage
} from './acp-rpc-envelope'

type RejectPending = (id: number, error: (method: string) => Error) => void

/** A record no envelope reads still fails the call its id names. */
export function rejectUnreadableAcpReply(record: unknown, rejectPending: RejectPending): void {
  const response = z.object({ id: z.number(), method: z.undefined().optional() }).safeParse(record)
  if (response.success) {
    rejectPending(response.data.id, invalidAcpResponseEnvelope(record))
  }
}

/** Settles the outstanding call an agent's reply answers; a malformed reply fails its call. */
export function settleAcpReply(input: {
  record: unknown
  frame: AcpJsonRpcMessage
  pending: Map<number, AcpPendingResponse>
  rejectPending: RejectPending
  diagnose: (message: string) => void
}): void {
  const { frame } = input
  if ('result' in frame === 'error' in frame) {
    input.diagnose('Ignored invalid ACP response')
    if (typeof frame.id === 'number') {
      input.rejectPending(frame.id, invalidAcpResponseEnvelope(input.record))
    }
    return
  }
  const pending = typeof frame.id === 'number' ? input.pending.get(frame.id) : undefined
  if (!pending || typeof frame.id !== 'number') {
    return
  }
  input.pending.delete(frame.id)
  clearTimeout(pending.timer)
  settleAcpResponse(frame, pending, input.diagnose)
}
