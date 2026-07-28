import { createHash } from 'node:crypto'

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function createOrchestrationWorkerTerminalIdentity(dispatchId: string): {
  agentSessionCreateOperationId: string
  tabId: string
  leafId: string
  preAllocatedHandle: string
} {
  const operationId = createHash('sha256')
    .update('orca-orchestration-worker-terminal')
    .update('\0')
    .update(dispatchId)
    .digest('base64url')
  return {
    agentSessionCreateOperationId: operationId,
    tabId: deterministicUuid(`${operationId}:tab`),
    leafId: deterministicUuid(`${operationId}:leaf`),
    preAllocatedHandle: `term_${deterministicUuid(`${operationId}:handle`)}`
  }
}
