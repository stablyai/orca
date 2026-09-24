/**
 * An agent session is its own orchestration caller. A flag that names the caller may restate that
 * session, but one naming anyone else is refused before any handler runs — never dropped, never
 * allowed to win. Against a host that predates session callers this is the only guard: such a host
 * would honor the flag as the caller, which is how a chat consumed a sibling's mail (#21097).
 *
 * Whether `--from`/`--terminal` names the caller or a target is declared on the command's spec
 * (`identityFlagRoles`) and checked once, here, at the CLI entry, so a handler cannot forget it.
 */

import type { CommandSpec, IdentityFlag } from './command-spec'
import { RuntimeClientError } from './runtime/types'
import { readInjectedAgentSessionId } from '../shared/agent-session-caller-env'
import { normalizeOrchestrationActor } from '../shared/orchestration-actor'
import { isStructuredWorkerHandle } from '../shared/structured-worker-handle'

export function refuseConflictingSessionCallerFlags(
  spec: CommandSpec | undefined,
  flags: ReadonlyMap<string, string | boolean>,
  env: NodeJS.ProcessEnv = process.env
): void {
  const sessionId = readInjectedAgentSessionId(env)
  if (!sessionId || !spec?.identityFlagRoles) {
    return
  }
  for (const flagName of IDENTITY_FLAGS) {
    const declared = flags.get(flagName)
    if (
      spec.identityFlagRoles[flagName] === 'caller' &&
      typeof declared === 'string' &&
      !namesInjectedSession(declared, sessionId, env)
    ) {
      throw new RuntimeClientError(
        'consumer_fenced',
        `This command runs as agent session ${sessionId}, so --${flagName} ${declared} would act as a ` +
          `different caller. Drop --${flagName}: this session's orchestration commands already act as ` +
          `session:${sessionId}. No request was sent.`
      )
    }
  }
}

const IDENTITY_FLAGS: readonly IdentityFlag[] = ['from', 'terminal']

/** The session's own spellings, plus the handle a structured worker session was minted. */
function namesInjectedSession(value: string, sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return (
    normalizeOrchestrationActor(value)?.id === sessionId || value === injectedSessionAddress(env)
  )
}

/**
 * The address the host gives this session: a structured worker keeps the handle it was minted, any
 * other session is `session:<id>`. Only for text that must match what the host writes.
 */
export function injectedSessionAddress(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const sessionId = readInjectedAgentSessionId(env)
  if (!sessionId) {
    return undefined
  }
  const ownHandle = env.ORCA_TERMINAL_HANDLE
  return isStructuredWorkerHandle(ownHandle) ? ownHandle : `session:${sessionId}`
}
