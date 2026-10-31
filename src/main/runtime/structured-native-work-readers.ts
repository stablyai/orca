import type { StructuredAgentSessionHostDeps } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { OrchestrationDb } from './orchestration/db'
import { structuredParentAccountWork } from './orchestration/structured-parent-account-work'
import { structuredWorkerOwesWork } from './structured-worker-custody'

/** Both are re-read; assigned process custody remains separate from receiving-account ownership. */
export function structuredNativeWorkReaders(
  read: () => OrchestrationDb | null,
  readReceiving: () => OrchestrationDb | null = read
): Pick<StructuredAgentSessionHostDeps, 'hasOpenDispatch' | 'parentAccountWork'> {
  return {
    hasOpenDispatch: (record) => structuredWorkerOwesWork(read(), record),
    parentAccountWork: (record, root, response, reader) =>
      structuredParentAccountWork(readReceiving(), record, root, response, reader)
  }
}
