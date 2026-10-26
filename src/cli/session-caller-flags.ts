// Fence caller flags before dispatch: older hosts would let a session act as another caller.

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

// Avoid loading the address codec graph at CLI entry for every command.
function namesInjectedSession(value: string, sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return (
    value === sessionId ||
    value === `${ORCA_SESSION_ADDRESS_PREFIX}${sessionId}` ||
    value === injectedSessionAddress(env)
  )
}

/** Only the host can distinguish this session's /clear lineage root from another caller. */
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
