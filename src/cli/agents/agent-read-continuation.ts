import type { AgentReadResult } from '../../shared/agent-conversations/agent-conversation-contracts'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../shared/agent-session/identity/orca-session-address-prefix'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import {
  quoteCliCommandArgument,
  quoteCliCommandArgumentForEveryShell
} from '../arguments/shell-command-quote'
import { resolveEnvironmentIdForStore } from '../hosts/execution-host-flag'
import { isLocalEnvironmentSelector } from '../hosts/local-environment-selector'
import { resolveOrchestrationCliExecutable } from '../orchestration/recovery/orchestration-recovery-command'

/** The connection this call chose on its own command line, so the next page comes from the same
 *  host; an ambient ORCA_ENVIRONMENT is inherited, so it isn't printed. Null when it can't be
 *  printed: a saved server with no canonical id to show instead of the typed name, or a pairing
 *  code, which is a credential. */
export async function agentReadConnectionArgs(
  flags: Map<string, string | boolean>
): Promise<string[] | null> {
  const environment = flags.get('environment')
  // An explicit local pin overrides an ambient selection, so it is printed too.
  if (isLocalEnvironmentSelector(environment)) {
    return ['--environment', 'local']
  }
  if (typeof environment === 'string') {
    const id = await resolveEnvironmentIdForStore(environment)
    return id ? ['--environment', id] : null
  }
  // Never echo a pairing code into output an agent may log.
  return typeof flags.get('pairing-code') === 'string' ? null : []
}

// What Orca issues: a versioned prefix over base64url, within the decoder's length limit.
const PRINTABLE_CURSOR = /^[A-Za-z0-9_-]{1,2048}$/

/** The line that reads the next older page, or says why none can be read; null when the page
 *  is the agent's oldest. */
export function agentReadClosingLine(
  result: Pick<AgentReadResult, 'orcaSessionId' | 'nextCursor' | 'clearedBefore'>,
  call: { limit: number | undefined; connection: readonly string[] | null }
): string | null {
  const { nextCursor } = result
  const lead = result.clearedBefore ? 'Before this: /clear. Earlier conversation:' : 'Older:'
  if (!nextCursor) {
    return result.clearedBefore
      ? "Before this: /clear. Orca can't read the earlier conversation here."
      : null
  }
  // The host's cursor is printed bare below, so anything but an opaque token is refused.
  if (!PRINTABLE_CURSOR.test(nextCursor)) {
    return `${lead} the host returned a cursor Orca won't print; read with --json to get it.`
  }
  // cmd and PowerShell run a quoted program path differently, so on Windows only a bare name runs.
  const executable = resolveOrchestrationCliExecutable()
  const program =
    process.platform === 'win32' && quoteCliCommandArgument(executable) !== executable
      ? null
      : quoteCliCommandArgumentForEveryShell(executable)
  const parts = [
    program,
    ...[
      'agent',
      'read',
      `${ORCA_SESSION_ADDRESS_PREFIX}${result.orcaSessionId}`,
      '--cursor',
      nextCursor,
      ...(call.limit !== undefined ? ['--limit', String(call.limit)] : []),
      ...(call.connection ?? [])
    ].map(quoteCliCommandArgumentForEveryShell)
  ]
  // A value no quoting keeps inert in every shell, or a host's ID that isn't one: cursor only.
  return call.connection &&
    isOrcaSessionId(result.orcaSessionId) &&
    parts.every((part) => part !== null)
    ? `${lead} ${parts.join(' ')}`
    : `${lead} --cursor ${nextCursor} (repeat your last command with this --cursor)`
}
