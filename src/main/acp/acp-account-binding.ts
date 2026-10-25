import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { resolveStructuredEnvAccountHomePath } from '../runtime/structured-agent-account-home'

type AccountPin = { accountHomeVariable: string } | { accountLocatorKind: 'opencode' }

export type AcpAccountBinding = {
  pin: AccountPin
  /** Resolves the current selection without side effects. */
  resolve(input: {
    launchEnv: NodeJS.ProcessEnv
    stateDirectory: string
  }): Promise<AgentSessionAccountHome>
  /** Throws if the pinned account belongs to another kind. */
  environment(home: AgentSessionAccountHome, env: Record<string, string>): Record<string, string>
  /** Runs before every spawn, never on reads. */
  prepare?(env: Readonly<Record<string, string>>): Promise<void>
}

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

/** Restricts plaintext sign-in folders to their owner before every spawn. */
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
