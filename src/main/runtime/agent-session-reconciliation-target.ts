import { isDeepStrictEqual } from 'node:util'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

export function agentSessionReconciliationTargetMatches(
  current: AgentSessionRecord,
  probed: AgentSessionRecord
): boolean {
  return isDeepStrictEqual(current, probed)
}
