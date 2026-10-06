import {
  buildWindowsHostInteractiveLoginSpawn,
  type WindowsHostInteractiveLoginSpawn
} from '../../shared/windows-interactive-login-spawn'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { resolveCodexCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'

export function createCodexHostLoginSpawn(managedHomePath: string): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  codexCommand: string
  interactiveLogin: WindowsHostInteractiveLoginSpawn | null
} {
  const codexCommand = resolveCodexCommand()
  // Native Windows login needs a console to read device-auth or paste-code prompts.
  const interactiveLogin =
    process.platform === 'win32'
      ? buildWindowsHostInteractiveLoginSpawn(codexCommand, ['login'])
      : null
  const { spawnCmd, spawnArgs } = interactiveLogin
    ? { spawnCmd: interactiveLogin.command, spawnArgs: interactiveLogin.args }
    : getSpawnArgsForWindows(codexCommand, ['login'])
  return {
    command: spawnCmd,
    args: spawnArgs,
    env: withCliRuntimeOnPath(codexCommand, { ...process.env, CODEX_HOME: managedHomePath }),
    codexCommand,
    interactiveLogin
  }
}
