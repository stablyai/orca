// What a tool process several chats share gives one session's tools in place of a chat's own seal.
import {
  CALLER_IDENTITY_ENV,
  ORCA_AGENT_SESSION_TOOL_TOKEN_ENV
} from '../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { ORCA_STRUCTURED_SESSION_ENV } from '../../../../shared/agent-launch/environment/structured-session-marker'
import { REMOTE_RUNTIME_SELECTOR_ENV_KEYS } from '../../../ipc/pty/host-env/inherited-orca-identity-env'
import {
  RUNTIME_SOURCE_ID_ENV,
  RUNTIME_SOURCE_INCARNATION_ENV,
  RUNTIME_SOURCE_PROFILE_PATH_ENV
} from '../../../../shared/remote-runtime/host-catalog/runtime-source-env'

/** The names that route Orca's CLI, as the seal sets them; a shared process's tools need them too,
 *  and one the seal left unset must not keep the value of whoever started the shared process. */
const THIS_APP_CLI_ENV = [
  ORCA_STRUCTURED_SESSION_ENV,
  'ORCA_USER_DATA_PATH',
  'ORCA_CLI_COMMAND',
  ...REMOTE_RUNTIME_SELECTOR_ENV_KEYS,
  RUNTIME_SOURCE_ID_ENV,
  RUNTIME_SOURCE_INCARNATION_ENV,
  RUNTIME_SOURCE_PROFILE_PATH_ENV
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
  /** False once the child ended: a write still waiting must not land. */
  live: () => boolean
}) => Promise<() => Promise<void>>

/** A sealed child's caller identity, and the environment a shared process gives that session's
 *  tools instead: this app's CLI, the token Orca trades for the identity, and the identity unset. */
export function sharedToolProcessSessionEnv(
  sealed: Readonly<Record<string, string>>,
  token: string
): { caller: Record<string, string>; tools: Record<string, string | null> } {
  const caller = Object.fromEntries(
    CALLER_IDENTITY_ENV.flatMap((key) => (sealed[key] === undefined ? [] : [[key, sealed[key]]]))
  )
  return {
    caller,
    tools: {
      ...Object.fromEntries(THIS_APP_CLI_ENV.map((key) => [key, sealed[key] ?? null])),
      ...Object.fromEntries(CALLER_IDENTITY_ENV.map((key) => [key, null])),
      [ORCA_AGENT_SESSION_TOOL_TOKEN_ENV]: token
    }
  }
}
