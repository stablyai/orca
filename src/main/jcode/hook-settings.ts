// Why: jcode config paths and the [hooks] table contract. jcode loads lifecycle
// hooks from ~/.jcode/config.toml (or $JCODE_HOME/config.toml); Orca writes its
// managed observer hooks there so sessions launched outside Orca still report.
import { homedir } from 'node:os'
import { join } from 'node:path'

const JCODE_SCRIPT_BASE = 'jcode-hook'

// Why: only observer hooks. pre_tool is a synchronous gate that would add
// startup latency to every tool call without gating anything for Orca.
export const JCODE_HOOK_EVENTS = ['turn_end', 'session_start', 'session_end', 'post_tool'] as const
export type JcodeHookEvent = (typeof JCODE_HOOK_EVENTS)[number]

export function getJcodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.JCODE_HOME?.trim()
  return explicit ? join(explicit, 'config.toml') : join(homedir(), '.jcode', 'config.toml')
}

export function getJcodeRemoteConfigPath(remoteHome: string): string {
  return `${remoteHome.replace(/\/+$/, '')}/.jcode/config.toml`
}

export function getJcodeManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${JCODE_SCRIPT_BASE}.cmd` : `${JCODE_SCRIPT_BASE}.sh`
}

export function getJcodePosixManagedScriptFileName(): string {
  return `${JCODE_SCRIPT_BASE}.sh`
}

export function getJcodeManagedScriptPath(): string {
  return getSharedJcodeScriptPath(getJcodeManagedScriptFileName())
}

export function getSharedJcodeScriptPath(scriptFileName: string): string {
  return join(homedir(), '.orca', 'agent-hooks', scriptFileName)
}

// Why: jcode executes hook commands directly (not through a shell), so the
// managed value must be the bare script path — no `if [ -f … ]` wrapper. Paths
// with spaces are handled by jcode's shell-style command parsing.
export function getJcodeManagedCommand(scriptPath: string): string {
  return scriptPath
}

export function getJcodeRemoteManagedCommand(scriptPath: string): string {
  return scriptPath
}

export function isJcodeManagedCommand(command: string | null | undefined): boolean {
  return typeof command === 'string' && command.includes('agent-hooks/jcode-hook')
}
