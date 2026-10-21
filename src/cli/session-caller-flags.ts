/**
 * An agent session is its own orchestration caller. A flag that names the caller may restate that
 * session, but one naming anyone else is refused before any effect — never dropped, never allowed
 * to win. Against a host that predates session callers this is the only guard: such a host
 * would honor the flag as the caller, which is how a chat consumed a sibling's mail (#21097).
 *
 * Whether `--from`/`--terminal` names the caller or a target is declared on the command's spec
 * (`identityFlagRoles`) and checked once, here, at the CLI entry, so a handler cannot forget it.
 *
 * A `/clear`ed chat keeps its lineage root's address, which only the host's records can place, so
 * a session address that is not this session's own spelling goes to the host's canonical-id check.
 */

import type { CommandSpec, IdentityFlag } from './command-spec'
import { RuntimeClientError } from './runtime/types'
import {
  injectedSessionAddress,
  readInjectedAgentSessionId
} from '../shared/agent-session-caller-env'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../shared/orca-session-address-prefix'

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
      !namesInjectedSession(declared, sessionId, env) &&
      !sessionAddressForHost(declared, sessionId, env)
    ) {
      throw new RuntimeClientError(
        'consumer_fenced',
        `This command runs as agent session ${sessionId}, so --${flagName} ${declared} would act as a ` +
          `different caller. Drop --${flagName}: this session's orchestration commands already act ` +
          `as this session. No request was sent.`
      )
    }
  }
}

const IDENTITY_FLAGS: readonly IdentityFlag[] = ['from', 'terminal']

/**
 * The session's own spellings, plus the handle a structured worker session was minted. Plain
 * strings: this runs at the CLI entry for every command, before the address codec's module graph.
 */
function namesInjectedSession(value: string, sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return (
    value === sessionId ||
    value === `${ORCA_SESSION_ADDRESS_PREFIX}${sessionId}` ||
    value === injectedSessionAddress(env)
  )
}

/** A session address only the host can place: this session's `/clear` root, or someone else. */
export function sessionAddressForHost(
  value: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return value.startsWith(ORCA_SESSION_ADDRESS_PREFIX) &&
    !namesInjectedSession(value, sessionId, env)
    ? value
    : undefined
}
