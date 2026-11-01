import { homedir } from 'node:os'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import type { AcpAccountBinding } from '../acp/acp-account-binding'
import { resolveDefaultHermesHome } from './hermes-default-home'

const HERMES_HOME_VARIABLE = 'HERMES_HOME'

function launchHomeDir(launchEnv: NodeJS.ProcessEnv): string {
  const home = launchEnv.HOME?.trim() || launchEnv.USERPROFILE?.trim()
  return home ? home : homedir()
}

/** Pins `HERMES_HOME`. Windows defaults follow `%LOCALAPPDATA%\\hermes` when that tree exists. */
export function hermesAcpAccountBinding(): AcpAccountBinding {
  return {
    pin: { accountHomeVariable: HERMES_HOME_VARIABLE },
    resolve: async ({ launchEnv }) => ({
      variable: HERMES_HOME_VARIABLE,
      path: resolveAbsoluteDirOverride(
        launchEnv.HERMES_HOME ?? process.env.HERMES_HOME,
        resolveDefaultHermesHome({
          // A launch env that omits LOCALAPPDATA still inherits the host's Windows default.
          env: launchEnv.LOCALAPPDATA !== undefined ? launchEnv : process.env,
          homeDir: launchHomeDir(launchEnv),
          platform: process.platform
        })
      )
    }),
    environment: (home: AgentSessionAccountHome, env) => {
      if (!isLegacyAgentSessionAccountHome(home) || home.variable !== HERMES_HOME_VARIABLE) {
        throw new Error(`sessions of this agent pin ${HERMES_HOME_VARIABLE}`)
      }
      return { ...env, [HERMES_HOME_VARIABLE]: home.path }
    }
  }
}
