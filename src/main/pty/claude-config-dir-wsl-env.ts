import { parseWslPath } from '../wsl'
import { addWslEnvKeys } from '../wsl-env'

function isHostClaudeConfigDirForWsl(value: string): boolean {
  const trimmed = value.trim()
  return /^[A-Za-z]:(?:[\\/]|$)/.test(trimmed) || trimmed.startsWith('\\\\')
}

/**
 * Normalize CLAUDE_CONFIG_DIR for a wsl.exe launch: translate a UNC value that
 * belongs to the launch distro into its Linux path, drop values the distro
 * cannot use, and name what survives in WSLENV.
 *
 * Why: wsl.exe imports only the vars named in WSLENV, so a Windows-side
 * CLAUDE_CONFIG_DIR left in place would point the distro's Claude at a `C:\...`
 * directory it cannot read.
 */
export function applyWslClaudeConfigDirEnv(
  env: Record<string, string>,
  launchWslDistro: string | null
): void {
  const value = env.CLAUDE_CONFIG_DIR
  if (!value) {
    return
  }
  const wslInfo = parseWslPath(value)
  if (wslInfo) {
    if (launchWslDistro && launchWslDistro !== wslInfo.distro) {
      delete env.CLAUDE_CONFIG_DIR
      return
    }
    env.CLAUDE_CONFIG_DIR = wslInfo.linuxPath
    addWslEnvKeys(env, ['CLAUDE_CONFIG_DIR'])
    return
  }
  if (isHostClaudeConfigDirForWsl(value)) {
    delete env.CLAUDE_CONFIG_DIR
    return
  }
  addWslEnvKeys(env, ['CLAUDE_CONFIG_DIR'])
}
