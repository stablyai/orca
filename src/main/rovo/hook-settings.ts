import { homedir } from 'node:os'
import { join, posix as pathPosix } from 'node:path'
import { wrapPosixHookCommand } from '../agent-hooks/posix-hook-command'

// Rovo runs hook commands through a POSIX shell, so one curl-based script serves every host.
export const ROVO_MANAGED_SCRIPT_FILE_NAME = 'rovo-hook.sh'

// Why: Rovo parses hook stdout as JSON and disables a hook that fails, so every path answers `{}`.
export const ROVO_HOOK_EMPTY_RESPONSE = '{}'

// Why: the `rovo` launcher and CLI hard-code `~/.rovo` (sessions, config.yml) with no home override.
export function getRovoConfigPath(): string {
  return join(homedir(), '.rovo', 'config.yml')
}

export function getRovoRemoteConfigPath(remoteHome: string): string {
  return pathPosix.join(remoteHome, '.rovo', 'config.yml')
}

export function getRovoManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath, {}, { fallbackStdout: ROVO_HOOK_EMPTY_RESPONSE })
}
