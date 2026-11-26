import { resolveCliCommandAsync } from '../../shared/shell/command-resolution/node-cli-command-async-resolution'
import { resolveCliCommand } from '../../shared/shell/command-resolution/node-cli-command-resolution'
import {
  readGuestWindowsDriveMountsAsync,
  resolveGuestNativeProgram,
  resolveGuestNativeProgramAsync
} from '../wsl/filesystem/wsl-guest-windows-drive-path'
import { WINDOWS_ONLY_AGENT_CLI_DIR } from './windows-only-agent-cli'
import { isAbsolute } from 'node:path'
import {
  managedAgentCommand,
  type ManagedAgentCliId
} from '../managed-agent-cli/managed-agent-cli-registry'

export {
  getVersionManagerBinPaths,
  resolveCliCommand,
  resolveCliCommands,
  resolveExecutableCommand,
  withCliRuntimeOnPath
} from '../../shared/shell/command-resolution/node-cli-command-resolution'
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

/** The user's own install wins; Orca's copy serves hosts that have none. */
function orUseManagedCopy(agent: ManagedAgentCliId, resolved: string): string {
  return isAbsolute(resolved) && !resolved.startsWith(WINDOWS_ONLY_AGENT_CLI_DIR)
    ? resolved
    : (managedAgentCommand(agent) ?? resolved)
}

export function resolveCodexCommand(options: ResolveCommandOptions = {}): string {
  return orUseManagedCopy('codex', resolveGuestNativeAgentCommand('codex', options))
}

/** Per-spawn lookup (#35565): only Windows' per-candidate stats are slow enough to move off the event loop. */
export async function resolveCodexCommandForSpawn(): Promise<string> {
  // win32 has no WSL drive mounts, so the guest-native skip would be a no-op there.
  return process.platform === 'win32'
    ? orUseManagedCopy('codex', await resolveCliCommandAsync('codex'))
    : resolveCodexCommand()
}

/** Async on every platform, for work that must not block the Electron main thread. */
export async function resolveCodexCommandForDelete(): Promise<string> {
  const mounts = await readGuestWindowsDriveMountsAsync()
  const resolved =
    mounts.length > 0
      ? await resolveGuestNativeProgramAsync('codex', {}, mounts)
      : await resolveCliCommandAsync('codex')
  return orUseManagedCopy('codex', resolved ?? `${WINDOWS_ONLY_AGENT_CLI_DIR}/codex`)
}

export function resolveClaudeCommand(options: ResolveCommandOptions = {}): string {
  return orUseManagedCopy('claude', resolveGuestNativeAgentCommand('claude', options))
}
