import { parsePtyCreateOperationId } from '../shared/pty-create-operation-inspection'
export { AGENT_SESSION_CREATE_OPERATION_ID_PATTERN } from '../shared/pty-create-operation-inspection'

/** Historical creation evidence only; never activates a route or establishes current liveness. */
export async function inspectPtyCreateOperation(
  params: Record<string, unknown>,
  operations: ReadonlyMap<string, Promise<{ id: string; incarnationId: string }>>
) {
  const operationId = parsePtyCreateOperationId(params.agentSessionCreateOperationId)
  const unverifiable = { version: 1 as const, operationId, outcome: 'unverifiable' as const }
  const operation = operations.get(operationId)
  if (!operation) {
    return unverifiable
  }
  try {
    const result = await operation
    if (operations.get(operationId) !== operation) {
      return unverifiable
    }
    return {
      version: 1 as const,
      operationId,
      outcome: 'recorded' as const,
      terminalId: result.id,
      incarnationId: result.incarnationId
    }
  } catch {
    return unverifiable
  }
}
