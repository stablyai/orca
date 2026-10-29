import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { resolveGuestNativeProgram } from '../ipc/wsl-guest-windows-drive-path'
import { WINDOWS_ONLY_AGENT_CLI_DIR } from './windows-only-agent-cli'

export {
  getVersionManagerBinPaths,
  resolveCliCommand,
  resolveCliCommands,
  resolveExecutableCommand,
  withCliRuntimeOnPath
} from '../../shared/node-cli-command-resolution'
export { WINDOWS_ONLY_AGENT_CLI_DIR } from './windows-only-agent-cli'

type ResolveCommandOptions = NonNullable<Parameters<typeof resolveCliCommand>[1]>

/**
 * On a WSL-host orcad, a Windows-only copy reads as not installed: a path every spawn (ENOENT) and
 * stat reports missing, never a bare name the spawn's own PATH search would take to the Windows
 * shim. Unchanged wherever there are no Windows drive mounts.
 */
export function resolveGuestNativeAgentCommand(
  name: string,
  options: ResolveCommandOptions = {},
  mounts?: readonly string[]
): string {
  return (
    resolveGuestNativeProgram(name, options, resolveCliCommand, mounts) ??
    `${WINDOWS_ONLY_AGENT_CLI_DIR}/${name}`
  )
}

export function resolveCodexCommand(options: ResolveCommandOptions = {}): string {
  return resolveGuestNativeAgentCommand('codex', options)
}

export function resolveClaudeCommand(options: ResolveCommandOptions = {}): string {
  return resolveGuestNativeAgentCommand('claude', options)
}
