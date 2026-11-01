import type { DispatchCreator } from '../../orchestration/db/dispatch-depth'
import type { AgentSessionRecordReader } from '../../orchestration/structured-session-lineage'
import { captureAgentSessionRecordInputs } from '../../structured-worker-authority'

/** Raw projection captures share the owning identity generation, including successful nulls. */
export function createTerminalIdentityProjectionInputs() {
  const callers = new Map<string, DispatchCreator>()
  let records: AgentSessionRecordReader | null | undefined
  return {
    caller(handle: string, read: () => DispatchCreator): DispatchCreator {
      if (!callers.has(handle)) {
        callers.set(handle, read())
      }
      return callers.get(handle)!
    },
    records(read: () => AgentSessionRecordReader | null): AgentSessionRecordReader | null {
      if (records === undefined) {
        records = captureAgentSessionRecordInputs(read())
      }
      return records
    }
  }
}
