import type { CodexAppServerConnection } from './codex-app-server-connection'
import { WORK_INBOX_ROUTING_INSTRUCTIONS } from '../../shared/work-inbox-routing-instructions'

/** Read the effective project/profile layers before appending; never replace unknown instructions. */
export async function codexWorkInboxDeveloperInstructions(
  connection: Pick<CodexAppServerConnection, 'request'>,
  cwd: string
): Promise<string> {
  const response = await connection.request('config/read', { cwd }, { timeoutMs: 8000 })
  if (
    typeof response !== 'object' ||
    response === null ||
    !('config' in response) ||
    typeof response.config !== 'object' ||
    response.config === null
  ) {
    throw new Error(
      'Orca Work Inbox could not read the effective Codex instructions; launch was not continued.'
    )
  }
  const previous =
    'developer_instructions' in response.config ? response.config.developer_instructions : null
  if (previous !== null && previous !== undefined && typeof previous !== 'string') {
    throw new Error('Orca Work Inbox cannot preserve the effective Codex instructions.')
  }
  return [previous, WORK_INBOX_ROUTING_INSTRUCTIONS].filter(Boolean).join('\n\n')
}
