// A status reply can describe the server after reconnecting, but it cannot confirm the lost action.
import type { OrcadManagedRuntimeStatus } from '../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'

const STATUS_ATTEMPTS = 15
const STATUS_RETRY_MS = 2_000
const UNKNOWN_OUTCOME =
  'The connection closed before Orca could confirm the action outcome. Run `orca environment status` before retrying.'

export async function reportAfterClosedConnection(
  { client }: HandlerContext,
  selector: { selector: string },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<never> {
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    await sleep(STATUS_RETRY_MS)
    const response = await client
      .call<OrcadManagedRuntimeStatus>('managedServer.status', selector)
      .catch(() => null)
    if (!response) {
      continue
    }
    const status = response.result
    const version = status.activeVersion
      ? `The server currently reports active version ${status.activeVersion}.`
      : 'The server currently reports no active version.'
    throw new RuntimeClientError(
      'managed_server_outcome_unknown',
      `${UNKNOWN_OUTCOME} ${version}`,
      status
    )
  }
  throw new RuntimeClientError('managed_server_outcome_unknown', UNKNOWN_OUTCOME)
}
