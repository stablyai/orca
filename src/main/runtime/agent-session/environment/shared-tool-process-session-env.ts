// What a tool process several chats share gives one session's tools in place of a chat's own seal.
import {
  CALLER_IDENTITY_ENV,
  ORCA_AGENT_SESSION_TOOL_TOKEN_ENV
} from '../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { ORCA_STRUCTURED_SESSION_ENV } from '../../../../shared/agent-launch/environment/structured-session-marker'
import { REMOTE_RUNTIME_SELECTOR_ENV_KEYS } from '../../../ipc/pty/host-env/inherited-orca-identity-env'

/** The seal's names that route Orca's CLI to this app, which a shared process's tools need too. */
const THIS_APP_CLI_ENV = [
  ORCA_STRUCTURED_SESSION_ENV,
  'ORCA_USER_DATA_PATH',
  'ORCA_CLI_COMMAND',
  ...REMOTE_RUNTIME_SELECTOR_ENV_KEYS
]

/** Every name `sharedToolProcessSessionEnv` gives a session's tools. */
export const SHARED_TOOL_PROCESS_SESSION_ENV_NAMES: readonly string[] = [
  ...THIS_APP_CLI_ENV,
  ...CALLER_IDENTITY_ENV,
  ORCA_AGENT_SESSION_TOOL_TOKEN_ENV
]

/** Hands a session's tool environment to the shared process, by the provider's own session id;
 *  resolves to its withdrawal. */
export type PublishSharedToolProcessSessionEnv = (input: {
  /** The launch's sealed environment (the agent's home, for one). */
  env: Readonly<Record<string, string>>
  providerSessionId: string
  /** `null` unsets a name the shared process inherited. */
  values: Readonly<Record<string, string | null>>
}) => Promise<() => Promise<void>>

/** A sealed child's caller identity, and the environment a shared process gives that session's
 *  tools instead: this app's CLI, the token Orca trades for the identity, and the identity unset. */
export function sharedToolProcessSessionEnv(
  sealed: Readonly<Record<string, string>>,
  token: string
): { caller: Record<string, string>; tools: Record<string, string | null> } {
  const pick = (keys: readonly string[]) =>
    Object.fromEntries(
      keys.flatMap((key) => (sealed[key] === undefined ? [] : [[key, sealed[key]]]))
    )
  return {
    caller: pick(CALLER_IDENTITY_ENV),
    tools: {
      ...pick(THIS_APP_CLI_ENV),
      ...Object.fromEntries(CALLER_IDENTITY_ENV.map((key) => [key, null])),
      [ORCA_AGENT_SESSION_TOOL_TOKEN_ENV]: token
    }
  }
}
