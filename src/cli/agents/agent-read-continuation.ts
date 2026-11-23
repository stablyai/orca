import type { AgentReadResult } from '../../shared/agent-conversations/agent-conversation-contracts'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../shared/agent-session/identity/orca-session-address-prefix'
import { quoteCliCommandArgumentForEveryShell } from '../arguments/shell-command-quote'
import { resolveEnvironmentIdForStore } from '../hosts/execution-host-flag'
import { isLocalEnvironmentSelector } from '../hosts/local-environment-selector'

/** The connection flags this call chose on its own command line, so the next page comes from the
 *  same host: a saved server by its canonical id (never the typed name), an explicit local pin
 *  (it overrides an ambient selection), or the caller's pairing code. An ambient ORCA_ENVIRONMENT
 *  is inherited by the next call, so it isn't printed. */
export async function agentReadConnectionArgs(
  flags: Map<string, string | boolean>
): Promise<string[]> {
  const environment = flags.get('environment')
  if (isLocalEnvironmentSelector(environment)) {
    return ['--environment', 'local']
  }
  if (typeof environment === 'string') {
    return ['--environment', await resolveEnvironmentIdForStore(environment)]
  }
  const pairingCode = flags.get('pairing-code')
  return typeof pairingCode === 'string' ? ['--pairing-code', pairingCode] : []
}

/** The line that reads the next older page, or says why none can be read; null when the page
 *  is the agent's oldest. */
export function agentReadClosingLine(
  result: Pick<AgentReadResult, 'orcaSessionId' | 'nextCursor' | 'clearedBefore'>,
  call: { limit: number | undefined; connection: readonly string[] }
): string | null {
  const { nextCursor } = result
  const lead = result.clearedBefore ? 'Before this: /clear. Earlier conversation:' : 'Older:'
  if (!nextCursor) {
    return result.clearedBefore
      ? "Before this: /clear. Orca can't read the earlier conversation here."
      : null
  }
  const args = [
    'orca',
    'agent',
    'read',
    `${ORCA_SESSION_ADDRESS_PREFIX}${result.orcaSessionId}`,
    '--cursor',
    nextCursor,
    ...(call.limit !== undefined ? ['--limit', String(call.limit)] : []),
    ...call.connection
  ].map(quoteCliCommandArgumentForEveryShell)
  // A value no quoting keeps inert in every shell: print the cursor alone, never a command.
  return args.every((arg) => arg !== null)
    ? `${lead} ${args.join(' ')}`
    : `${lead} --cursor ${nextCursor} (repeat your last command with this --cursor)`
}
