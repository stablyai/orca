import type { IPtyProvider } from './types'
import {
  parsePtyCreateOperationId,
  parsePtyCreateOperationInspection
} from '../../shared/pty-create-operation-inspection'

/** Read-only historical observation; callers retain ownership and recovery fences. */
export async function inspectSshPtyCreateOperation(options: {
  provider: Pick<IPtyProvider, 'requestHostRpc'>
  operationId: string
  signal: AbortSignal
  assertCurrent: () => void
}) {
  const operationId = parsePtyCreateOperationId(options.operationId)
  const request = options.provider.requestHostRpc?.bind(options.provider)
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    options.assertCurrent()
  }
  assertCurrent()
  if (!request) {
    throw new Error('agent_session_operation_inspection_unsupported')
  }
  const requestOptions = { signal: options.signal, timeoutMs: 5_000 }
  const capabilities = (await request('pty.getCapabilities', {}, requestOptions)) as {
    agentSessionCreateOperationInspectionVersion?: unknown
  } | null
  assertCurrent()
  if (capabilities?.agentSessionCreateOperationInspectionVersion !== 1) {
    throw new Error('agent_session_operation_inspection_unsupported')
  }
  const result = await request(
    'pty.inspectCreateOperation',
    {
      agentSessionCreateOperationId: operationId
    },
    requestOptions
  )
  assertCurrent()
  return parsePtyCreateOperationInspection(result, operationId)
}
