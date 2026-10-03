import { addWslEnvKeys } from '../../shared/wsl-env'
import type { TuiAgent } from '../../shared/tui-agent'
import { deleteRequestedEnvKeys } from '../ipc/pty/host-env/path'
import { probeOpenCodeLaunchCapabilities } from './opencode-launch-capabilities'

export async function prepareOpenCodePtyLaunch(options: {
  command: string | undefined
  agent?: TuiAgent
  env: Record<string, string> | undefined
  envToDelete: string[]
  cwd?: string
  connectionId?: string | null
  isFreshLaunch: boolean
  wsl?: { distro?: string }
}): Promise<Record<string, string> | undefined> {
  const env = options.env ? { ...options.env } : undefined
  if (env) {
    delete env.ORCA_OPENCODE_PLUGIN_API
  }
  // Providers merge their own ambient environment after this preparation.
  if (!options.envToDelete.includes('ORCA_OPENCODE_PLUGIN_API')) {
    options.envToDelete.push('ORCA_OPENCODE_PLUGIN_API')
  }
  if (options.connectionId || !options.isFreshLaunch) {
    return env
  }
  const probeEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) {
      probeEnv[key] = value
    }
  }
  deleteRequestedEnvKeys(probeEnv, options.envToDelete)
  const capabilities = await probeOpenCodeLaunchCapabilities({
    ...options,
    env: probeEnv
  })
  if (!capabilities || capabilities.pluginApi === 'unknown') {
    return env
  }
  const launchEnv = { ...env, ORCA_OPENCODE_PLUGIN_API: capabilities.pluginApi }
  options.envToDelete.splice(options.envToDelete.indexOf('ORCA_OPENCODE_PLUGIN_API'), 1)
  if (options.wsl) {
    addWslEnvKeys(launchEnv, ['ORCA_OPENCODE_PLUGIN_API'])
  }
  return launchEnv
}
