// Honor JCODE_HOME so hooks land in the config jcode actually reads.
import { homedir } from 'node:os'
import { join } from 'node:path'

const JCODE_SCRIPT_BASE = 'jcode-hook'

// pre_tool observes running tools and unanswered questions; its POST is detached so the gate never blocks on HTTP.
export const JCODE_HOOK_EVENTS = [
  'session_start',
  'turn_start',
  'pre_tool',
  'post_tool',
  'turn_end',
  'session_end'
] as const
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

// jcode tokenizes commands before direct execution; quote paths to preserve Windows separators and spaces.
export function getJcodeManagedCommand(scriptPath: string): string {
  return scriptPath.includes("'")
    ? `"${scriptPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    : `'${scriptPath}'`
}

export function getJcodeRemoteManagedCommand(scriptPath: string): string {
  return getJcodeManagedCommand(scriptPath)
}

// Normalize Windows separators before matching the managed script.
export function isJcodeManagedCommand(command: string | null | undefined): boolean {
  return (
    typeof command === 'string' && command.replaceAll('\\', '/').includes('agent-hooks/jcode-hook')
  )
}
