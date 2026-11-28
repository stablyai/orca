import type { CliStatusResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeRpcSuccess } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeClient } from '../client'
import { RuntimeRestartWait } from '../connection/runtime-restart-wait'
import { runtimeRestartingError } from '../connection/runtime-restarting-error'

/** Status for a capability preflight: waits out an announced local restart like any other call. */
export async function readReachableCliStatus(
  client: Pick<RuntimeClient, 'getCliStatus' | 'isRemote' | 'userDataPath'>
): Promise<RuntimeRpcSuccess<CliStatusResult>> {
  const restartWait = new RuntimeRestartWait(client.userDataPath)
  for (;;) {
    const status = await client.getCliStatus()
    const { reachable } = status.result.runtime
    // After a restart, the graph serves shortly after the runtime answers; the command needs both.
    if (
      client.isRemote ||
      (reachable && (!restartWait.restart || status.result.graph.state === 'ready'))
    ) {
      return status
    }
    const retry = reachable ? await restartWait.pause() : await restartWait.shouldRetry()
    if (!retry) {
      if (!reachable && restartWait.restart) {
        throw runtimeRestartingError(restartWait.restart)
      }
      return status
    }
  }
}
