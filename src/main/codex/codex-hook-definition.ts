import { join } from 'node:path'
import {
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  writeHooksJson,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from '../agent-hooks/hook-stdin-contract'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import { CODEX_HOOK_EVENT_LABEL, getCodexManagedScriptFileName } from './codex-hook-identity'
import { getManagedScript } from './codex-hook-script'
import type { CodexEventLabel } from './config-toml-trust'

// Why: Pre/PostToolUse feed the live in-flight-tool readout; PermissionRequest exits with no decision so Codex still shows its approval UI while Orca flips the pane to waiting.
export const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop'
] as const

export function getConfigPath(runtimeHomePath: string = getOrcaManagedCodexHomePath()): string {
  return join(runtimeHomePath, 'hooks.json')
}

export function writeCodexHooksJson(
  configPath: string,
  hooks: Record<string, HookDefinition[]>
): void {
  // Why: Codex rejects unknown top-level hooks.json fields, so plugin bookkeeping like `_managed` must not survive Orca's rewrite.
  writeHooksJson(configPath, { hooks })
}

export function getCodexConfigTomlPath(
  runtimeHomePath: string = getOrcaManagedCodexHomePath()
): string {
  return join(runtimeHomePath, 'config.toml')
}

// Why: managed-event subset of the shared label map; full mapping lives in codex-hook-identity.ts so promotion can't drift.
export const CODEX_EVENT_LABEL: Record<(typeof CODEX_EVENTS)[number], CodexEventLabel> = {
  SessionStart: CODEX_HOOK_EVENT_LABEL.SessionStart!,
  UserPromptSubmit: CODEX_HOOK_EVENT_LABEL.UserPromptSubmit!,
  PreToolUse: CODEX_HOOK_EVENT_LABEL.PreToolUse!,
  PermissionRequest: CODEX_HOOK_EVENT_LABEL.PermissionRequest!,
  PostToolUse: CODEX_HOOK_EVENT_LABEL.PostToolUse!,
  SubagentStart: CODEX_HOOK_EVENT_LABEL.SubagentStart!,
  SubagentStop: CODEX_HOOK_EVENT_LABEL.SubagentStop!,
  Stop: CODEX_HOOK_EVENT_LABEL.Stop!
}

export const CODEX_MANAGED_EVENT_LABELS = new Set<CodexEventLabel>(
  CODEX_EVENTS.map((eventName) => CODEX_EVENT_LABEL[eventName])
)

export const CODEX_PLUGIN_ONLY_HOOK_PLACEHOLDERS = [
  '${CLAUDE_PLUGIN_ROOT}',
  '${CLAUDE_PLUGIN_DATA}',
  '${PLUGIN_ROOT}',
  '${PLUGIN_DATA}'
] as const

export function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getCodexManagedScriptFileName())
}

export function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsCmdHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export type CodexManagedHookInstallMaterial = {
  events: readonly (typeof CODEX_EVENTS)[number][]
  eventLabel: Record<(typeof CODEX_EVENTS)[number], CodexEventLabel>
  scriptPath: string
  command: string
  script: string
}

// Why: the real-home installer must byte-match the managed lane's events,
// command, and script, or trust signatures diverge between the two homes.
export function getCodexManagedHookInstallMaterial(): CodexManagedHookInstallMaterial {
  const scriptPath = getManagedScriptPath()
  return {
    events: CODEX_EVENTS,
    eventLabel: CODEX_EVENT_LABEL,
    scriptPath,
    command: getManagedCommand(scriptPath),
    script: getManagedScript()
  }
}

export function wrapReadablePosixHookCommand(scriptPath: string): string {
  const quoted = `'${scriptPath.replaceAll("'", "'\\''")}'`
  // Why: WSL hooks are written from Windows over UNC where the exec bit is unreliable; a missing script must still own stdin.
  return `if [ -f ${quoted} ] && [ -r ${quoted} ]; then /bin/sh ${quoted}; else ${POSIX_HOOK_STDIN_DRAIN_COMMAND}; fi`
}

export function getSystemConfigPath(): string {
  return join(getSystemCodexHomePath(), 'hooks.json')
}

export function getSystemCodexConfigTomlPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}
