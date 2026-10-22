// How an ACP agent's chats pin their account: what a new chat records, and how a launch points the
// agent at the account its record pinned. Both run on the machine that runs the agent.

import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
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
  resolve(input: {
    launchEnv: NodeJS.ProcessEnv
    stateDirectory: string
  }): Promise<AgentSessionAccountHome>
  /** `env` pointed at the pinned account; throws for an account of another kind. */
  environment(home: AgentSessionAccountHome, env: Record<string, string>): Record<string, string>
  /** Readies the account a start's `env` points at, before every spawn; reads never call it. */
  prepare?(env: Readonly<Record<string, string>>): Promise<void>
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

/** An agent whose account is a folder Orca keeps for it on each host, which the agent signs in to
 *  itself. It keeps that sign-in there in plain text, so every start makes the folder and
 *  `privateSubfolders` owner-only, whatever made them first. */
export function hostFolderAccountBinding(
  variable: string,
  folderName: string,
  privateSubfolders: readonly string[]
): AcpAccountBinding {
  const { pin, environment } = directoryAccountBinding(variable, () => folderName)
  return {
    pin,
    resolve: async ({ stateDirectory }) => ({ variable, path: join(stateDirectory, folderName) }),
    environment,
    prepare: async (env) => {
      const home = env[variable]
      if (!home) {
        throw new Error(`${variable} is not set`)
      }
      for (const path of [home, ...privateSubfolders.map((name) => join(home, name))]) {
        await mkdir(path, { recursive: true, mode: 0o700 })
        await chmod(path, 0o700)
      }
    }
  }
}
