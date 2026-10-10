// Why: jcode config paths and the [hooks] table contract. jcode loads lifecycle
// hooks from ~/.jcode/config.toml (or $JCODE_HOME/config.toml); Orca writes its
// managed observer hooks there so sessions launched outside Orca still report.
import { homedir } from 'node:os'
import { join } from 'node:path'

const JCODE_SCRIPT_BASE = 'jcode-hook'

// The lifecycle points Orca subscribes to, in the order jcode fires them.
// `pre_tool` is jcode's synchronous gate, but the managed script backgrounds its
// POST and exits 0 immediately, so Orca observes the tool without ever holding
// up a tool call. Without it a long `bash` would show no tool at all until it
// finished, and `request_permission` (the only jcode tool a human answers)
// would only be seen after the answer.
export const JCODE_HOOK_EVENTS = [
  'session_start',
  'turn_start',
  'pre_tool',
  'post_tool',
  'turn_end',
  'session_end'
] as const
export type JcodeHookEvent = (typeof JCODE_HOOK_EVENTS)[number]

/** jcode waits for this one; the managed script must never block on it. */
export function isJcodeGateHookEvent(event: JcodeHookEvent): boolean {
  return event === 'pre_tool'
}

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

// Why quoted: jcode executes hook commands directly (no shell), but it tokenizes the
// configured string shell-style first — parse_hook_command in jcode-terminal-launch
// splits on unquoted whitespace AND consumes every unquoted backslash as an escape, so
// a bare `C:\Users\me\.orca\agent-hooks\jcode-hook.cmd` reaches exec as
// `C:Usersme.orcaagent-hooksjcode-hook.cmd` and no Windows hook ever fires. Single
// quotes pass the path through verbatim (backslashes are literal inside them); a path
// that itself contains one falls back to double quotes, where \ and " are the escapes.
export function getJcodeManagedCommand(scriptPath: string): string {
  return scriptPath.includes("'")
    ? `"${scriptPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    : `'${scriptPath}'`
}

export function getJcodeRemoteManagedCommand(scriptPath: string): string {
  return getJcodeManagedCommand(scriptPath)
}

// Why the separator normalize: the stored command is a native path, so on Windows it
// carries backslashes and a `/`-only needle never matches its own managed entry.
export function isJcodeManagedCommand(command: string | null | undefined): boolean {
  return (
    typeof command === 'string' && command.replaceAll('\\', '/').includes('agent-hooks/jcode-hook')
  )
}
