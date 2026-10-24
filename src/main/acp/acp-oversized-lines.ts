import { classifyJsonRpcPrefix } from '../../shared/json-rpc-record-prefix'
import type { NdjsonRejectedRecord } from '../../shared/main-process-ndjson-framer'
import { AcpFrameTooLargeError, AcpRpcError } from './acp-errors'

export type AcpOversizedLineTarget = {
  rejectPending: (id: number, error: (method: string) => Error) => void
  refuse: (id: string | number, error: AcpRpcError) => void
  close: (error: Error) => void
  diagnose: (message: string) => void
}

/** Settle requests whose replies were lost to the framing limit. */
export function settleOversizedAcpLine(
  rejected: NdjsonRejectedRecord & { kind: 'line-too-long' },
  target: AcpOversizedLineTarget
): void {
  const { observedBytes, maxLineBytes } = rejected
  const record = classifyJsonRpcPrefix(rejected.prefix)
  target.diagnose(`Ignored ACP line: line-too-long (${record.kind})`)
  if (record.kind === 'server-request') {
    target.refuse(
      record.id,
      new AcpRpcError(-32600, `ACP request exceeds ${maxLineBytes} byte limit`, {
        method: record.method,
        observedBytes
      })
    )
  } else if (record.kind === 'response') {
    target.rejectPending(
      record.id,
      (method) => new AcpFrameTooLargeError(method, observedBytes, maxLineBytes)
    )
  } else if (record.kind === 'response-unknown') {
    // An unreadable response ID leaves every pending call suspect.
    target.close(new AcpFrameTooLargeError(null, observedBytes, maxLineBytes))
  }
  // Ignore oversized notifications and stray output without ending the session.
}
