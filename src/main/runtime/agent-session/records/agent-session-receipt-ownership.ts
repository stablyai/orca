import { createHash } from 'node:crypto'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'

type Receipt = {
  spawnTokenHash: string
  execution: { sessionId: string; runtimeFence: number; acquisitionGeneration: string }
  invalidated: boolean
  turnCompleted: boolean
  closure?: { root: 'exited' | 'unverifiable'; tree: 'exited' | 'unverifiable'; observedAt: number }
}

export function reconcileOwnedAgentSessionReceipt<T extends Receipt>(
  record: AgentSessionRecord,
  input: { sessionId: string; fence: number; generation: string; spawnToken: string },
  receipt: T,
  previous: T | null
): T {
  const hash = createHash('sha256').update(input.spawnToken).digest('hex')
  if (
    input.sessionId !== record.sessionId ||
    receipt.execution.sessionId !== record.sessionId ||
    input.fence !== record.lease.runtimeFence ||
    receipt.execution.runtimeFence !== input.fence ||
    receipt.execution.acquisitionGeneration !== input.generation ||
    receipt.spawnTokenHash !== hash ||
    (previous &&
      (previous.execution.acquisitionGeneration !== input.generation ||
        previous.spawnTokenHash !== hash)) ||
    !(
      (record.lease.claimStatus === 'live' &&
        record.lease.ownerProcess?.spawnToken === input.spawnToken) ||
      previous?.spawnTokenHash === hash
    )
  ) {
    throw new Error('Invalid owned execution receipt.')
  }
  return {
    ...receipt,
    invalidated: receipt.invalidated || previous?.invalidated === true,
    turnCompleted: receipt.turnCompleted || previous?.turnCompleted === true,
    ...(previous?.closure?.root === 'exited' && previous.closure.tree === 'exited'
      ? { closure: previous.closure }
      : !receipt.closure && previous?.closure
        ? { closure: previous.closure }
        : {})
  }
}
