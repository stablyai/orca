// How an ACP agent's chats pin their account: what a new chat records, and how a launch points the
// agent at the account its record pinned. Both run on the machine that runs the agent.

import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { resolveStructuredEnvAccountHomePath } from '../runtime/structured-agent-account-home'

type AccountPin = { accountHomeVariable: string } | { accountLocatorKind: 'opencode' }

export type AcpAccountBinding = {
  /** What the agent's definition says its records pin. */
  pin: AccountPin
  /** The account a new chat pins: the current selection, read without side effects. */
  resolve(input: { launchEnv: NodeJS.ProcessEnv }): Promise<AgentSessionAccountHome>
  /** `env` pointed at the pinned account; throws for an account of another kind. */
  environment(home: AgentSessionAccountHome, env: Record<string, string>): Record<string, string>
}

/** An agent whose account is one config directory named by `variable`, with a default under the
 *  user's home. */
export function directoryAccountBinding(
  variable: string,
  defaultHome: (homePath: string) => string
): AcpAccountBinding {
  return {
    pin: { accountHomeVariable: variable },
    resolve: async ({ launchEnv }) => ({
      variable,
      path: resolveStructuredEnvAccountHomePath({ launchEnv, variable, defaultPath: defaultHome })
    }),
    environment: (home, env) => {
      if (!isLegacyAgentSessionAccountHome(home) || home.variable !== variable) {
        throw new Error(`sessions of this agent pin ${variable}`)
      }
      return { ...env, [variable]: home.path }
    }
  }
}
