import {
  OPENCODE_CONFIG_DIR_ENV_KEYS,
  isOpenCodeLegacySharedConfigDir
} from '../../../opencode/legacy-shared-config-dir'
import { openCode2HookService, openCodeHookService } from '../../../opencode/hook-service'
import { resolveOpenCodeSourceConfigDir, restoreOrStripOverlayEnv } from './pi-agent'
import { selectOpenCodeHookAgent } from '../../../../shared/opencode-launch-command'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { resolveOpenCodeConfigDirectory } from '../../../../shared/opencode-config-directory'
import { readSessionShellStartupEnvVar } from '../../../pty/shell-startup-env'
import type { BuildPtyHostEnvOptions } from './types'

type OpenCodeSourceConfig = {
  inheritedEnv: NodeJS.ProcessEnv
  directory: string | undefined
}

export function captureOpenCodeSourceConfig(
  env: Record<string, string>,
  userDataPath: string
): OpenCodeSourceConfig {
  const isLegacyDirectory = (dir: string | undefined): boolean =>
    isOpenCodeLegacySharedConfigDir(dir, userDataPath)
  const inheritedEnv: NodeJS.ProcessEnv = {}
  for (const key of OPENCODE_CONFIG_DIR_ENV_KEYS) {
    if (isLegacyDirectory(env[key])) {
      delete env[key]
    }
    if (!isLegacyDirectory(process.env[key])) {
      inheritedEnv[key] = process.env[key]
    }
  }
  // A daemon or sibling shell can retain a retired path that main no longer sees.
  openCodeHookService.refreshLegacySharedPlugin()
  openCode2HookService.refreshLegacySharedPlugin()
  const directory = resolveOpenCodeSourceConfigDir(env, inheritedEnv)
  return { inheritedEnv, directory: isLegacyDirectory(directory) ? undefined : directory }
}

export function applyOpenCodeStatusPluginEnv(
  id: string,
  env: Record<string, string>,
  config: OpenCodeSourceConfig,
  options: Pick<
    BuildPtyHostEnvOptions,
    'launchAgent' | 'agentStatusHooksEnabled' | 'disabledTuiAgents' | 'isWsl' | 'shellPath'
  >,
  command: string | undefined
): 'opencode' | 'opencode2' | null {
  const agent = selectOpenCodeHookAgent(
    options.launchAgent,
    command,
    (candidate) =>
      options.agentStatusHooksEnabled && isTuiAgentEnabled(candidate, options.disabledTuiAgents)
  )
  restoreOrStripOverlayEnv(
    env,
    {
      primary: 'OPENCODE_CONFIG_DIR',
      overlay: 'ORCA_OPENCODE_CONFIG_DIR',
      source: 'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
      preserveExplicitPrimary: true
    },
    config.inheritedEnv
  )
  delete env.ORCA_OPENCODE_AGENT
  if (!agent) {
    return null
  }
  const service = agent === 'opencode2' ? openCode2HookService : openCodeHookService
  env.ORCA_OPENCODE_AGENT = agent
  // WSL owns its config writes; only the guest overlay may enter a WSL pane.
  if (!options.isWsl) {
    const executionEnv = { ...process.env, ...env }
    const shellConfigHome = readSessionShellStartupEnvVar('XDG_CONFIG_HOME', env, options.shellPath)
    const defaultConfigDir = resolveOpenCodeConfigDirectory({
      ...executionEnv,
      XDG_CONFIG_HOME: shellConfigHome ?? executionEnv.XDG_CONFIG_HOME
    })
    Object.assign(env, service.buildPtyEnv(id, config.directory, defaultConfigDir))
  }
  if (env.OPENCODE_CONFIG_DIR) {
    // Shell startup can re-export the default; preserve this pane's overlay and original source.
    env.ORCA_OPENCODE_CONFIG_DIR = env.OPENCODE_CONFIG_DIR
    if (config.directory) {
      env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = config.directory
    } else {
      delete env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
    }
  }
  return agent
}
