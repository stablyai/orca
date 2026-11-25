import { runKeyedSerializedOperation } from '../../../../../../shared/concurrency/keyed-serialized-operations'
import type { RpcContext } from '../../../core'

const admissions = new WeakMap<RpcContext['runtime'], Map<string, Promise<void>>>()

export function orderStructuredSendAdmission<T>(
  runtime: RpcContext['runtime'],
  sessionId: string,
  clientMessageId: string,
  operation: () => Promise<T>
): Promise<T> {
  let pending = admissions.get(runtime)
  if (!pending) {
    pending = new Map()
    admissions.set(runtime, pending)
  }
  return runKeyedSerializedOperation(
    pending,
    JSON.stringify([sessionId, clientMessageId]),
    operation
  )
}
