import type { ClickUpConnectionStatus } from '../../shared/clickup/clickup-types'
import type { HandlerContext } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'

/** Task text, ids and URLs never contain whitespace; a title passed by mistake fails here. */
export function requireClickUpTaskInput(context: HandlerContext): string {
  const input = getRequiredStringFlag(context.flags, 'id').trim()
  if (!input || /\s/.test(input)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Expected a ClickUp task id, custom id (ABC-123) or task URL.'
    )
  }
  return input
}

/**
 * Unconnected reads return empty results, which an agent cannot tell apart from "no tasks", so
 * every command except `clickup status` checks the connection first.
 */
export async function requireClickUpConnection(
  context: HandlerContext
): Promise<ClickUpConnectionStatus> {
  const { result: status } = await context.client.call<ClickUpConnectionStatus>('clickup.status')
  if (status.credentialError) {
    throw new RuntimeClientError('clickup_credentials_unavailable', status.credentialError)
  }
  if (!status.connected) {
    throw new RuntimeClientError(
      'clickup_not_connected',
      'ClickUp is not connected on this Orca host. Add a personal API token in Orca Settings, then run orca clickup status.'
    )
  }
  return status
}
