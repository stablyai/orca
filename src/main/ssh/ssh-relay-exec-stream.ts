import { buildPosixExecCommandLine } from '../debug/debug-adapter-posix-command-line'
import { shellEscape } from './ssh-connection-utils'

export type RemoteProcessSpawnRequest = {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}

/**
 * Builds a POSIX shell command line that `exec`s the target process directly
 * (replacing the shell) so a long-lived remote process — a DAP adapter, not
 * a one-shot command like `execCommand` runs — shares its lifetime 1:1 with
 * the SSH channel: closing the channel kills the process instead of leaving
 * an orphaned child behind a lingering shell.
 */
export function buildRemoteProcessCommand(request: RemoteProcessSpawnRequest): string {
  return buildPosixExecCommandLine(request, shellEscape)
}
