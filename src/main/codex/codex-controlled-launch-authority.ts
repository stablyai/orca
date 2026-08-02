import {
  resolveControlledCodexCommand,
  type ControlledCodexCommand
} from './codex-controlled-session-launch'

export type ControlledCodexLaunchAuthority = {
  codexHome: string
  accountId: string | null
  commandOverride: string
  command: ControlledCodexCommand
}

type ControlledCodexLaunchAuthorityOptions = {
  workspacePath: string
  commandOverride?: string
  prepareCodexHome: (workspacePath: string) => string | null
  getSystemCodexHome: () => string
  resolveAccountId: () => string | null
}

export function resolveControlledCodexLaunchAuthority(
  options: ControlledCodexLaunchAuthorityOptions
): ControlledCodexLaunchAuthority {
  const commandOverride = options.commandOverride?.trim() || 'codex'
  if (commandOverride.includes(String.fromCharCode(0)) || /[\r\n]/.test(commandOverride)) {
    throw new Error('controlled Codex command is invalid')
  }
  const command = resolveControlledCodexCommand(commandOverride)
  const codexHome = options.prepareCodexHome(options.workspacePath) ?? options.getSystemCodexHome()
  return {
    commandOverride,
    command,
    codexHome,
    accountId: options.resolveAccountId()
  }
}
