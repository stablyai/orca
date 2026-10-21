/**
 * An update or rollback restarts the managed server, and a CLI talking to that runtime then sees
 * its connection close mid-call. That is expected, not a failure: read the host's status once the
 * runtime answers again and report what the action left behind.
 */
import type { OrcadManagedRuntimeStatus } from '../../shared/orcad-managed-runtime'
import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'

const STATUS_ATTEMPTS = 15
const STATUS_RETRY_MS = 2_000

export async function reportAfterClosedConnection(
  { client, json }: HandlerContext,
  selector: { selector: string },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<void> {
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    await sleep(STATUS_RETRY_MS)
    let response: RuntimeRpcSuccess<OrcadManagedRuntimeStatus>
    try {
      response = await client.call<OrcadManagedRuntimeStatus>('managedServer.status', selector)
    } catch {
      continue
    }
    const status = response.result
    if (status.recovery) {
      throw new RuntimeClientError(
        'managed_server_interrupted',
        `The ${status.recovery.operation} of ${status.recovery.version} was interrupted. Run \`orca environment recover\`.`,
        status
      )
    }
    if (status.deferredUpdate) {
      throw new RuntimeClientError('managed_server_deferred', status.deferredUpdate.reason, status)
    }
    printResult(
      response,
      json,
      (value) =>
        `The server restarted during the action and now runs ${value.activeVersion ?? 'no version'}.`
    )
    return
  }
  throw new RuntimeClientError(
    'managed_server_in_progress',
    'The connection closed while the server restarted, and it has not answered since. Check `orca environment status`.'
  )
}
