import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'

type Environment = Readonly<Record<string, string | undefined>>

export function resolveDefaultOpenCodeConfigDir(
  ptyEnv: Environment,
  processEnv: Environment = process.env
): string | undefined {
  const home = ptyEnv.HOME || processEnv.HOME || homedir()
  const shell = ptyEnv.SHELL || processEnv.SHELL
  // Why: GUI process variables can differ from the shell environment OpenCode launches under.
  const configHome =
    ptyEnv.XDG_CONFIG_HOME ||
    processEnv.XDG_CONFIG_HOME ||
    readShellStartupEnvVar('XDG_CONFIG_HOME', home, shell) ||
    join(home, '.config')
  const configDir = join(configHome, 'opencode')
  return existsSync(configDir) ? configDir : undefined
}
