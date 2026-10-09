import type { RelayDispatcher } from './dispatcher'
import { BacklogRelayRequest } from '../shared/rpc-contract/backlog-params'
import { executeBacklogOperation } from '../main/backlog/backlog-service'
import { expandTilde } from './context'

/** Validates payloads on the host-user-trusted relay; registered-repo routing belongs to runtime RPC. */
export function registerBacklogHandler(dispatcher: RelayDispatcher): void {
  dispatcher.onRequest(
    'backlog.capabilities',
    /** Advertises the command contract without probing a project or requiring the CLI. */
    async () => ({ version: 1 })
  )
  dispatcher.onRequest(
    'backlog.execute',
    /** Parses untyped wire input before invoking the host-local adapter; this is not path authorization. */
    async (input) => {
      const params = BacklogRelayRequest.parse(input)
      return executeBacklogOperation(expandTilde(params.repoPath), params.operation)
    }
  )
}
