import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { join } from 'node:path'
import {
  buildManagedCommandHook,
  getSharedManagedScriptPath,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  writeHooksJson,
  type HookCommandConfig,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from '../agent-hooks/hook-stdin-contract'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import { buildCodexHookCommand } from './codex-hook-command-form'
import { CODEX_HOOK_EVENT_LABEL, getCodexManagedScriptFileName } from './codex-hook-identity'
import { getManagedScript } from './codex-hook-script'
import type { CodexEventLabel } from './config-toml-trust'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import { computeCodexTrustedHash, normalizeCodexHookTimeoutSec } from './codex-trust-identity'

// Pre/PostToolUse track in-flight tools; PermissionRequest marks waiting without deciding approval.
// Interrupt (Codex 0.150+) is the only hook an Esc-cancelled turn fires; older Codex ignores the unknown key.
export const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt'
] as const

export function getConfigPath(runtimeHomePath: string = getOrcaManagedCodexHomePath()): string {
  return join(runtimeHomePath, 'hooks.json')
}

export function writeCodexHooksJson(
  configPath: string,
  hooks: Record<string, HookDefinition[]>
): void {
  // Codex rejects unknown top-level fields such as plugin bookkeeping's _managed.
  writeHooksJson(configPath, { hooks })
}

export function getCodexConfigTomlPath(
  runtimeHomePath: string = getOrcaManagedCodexHomePath()
): string {
  return join(runtimeHomePath, 'config.toml')
}

// Share labels with promotion to prevent event-map drift.
export const CODEX_EVENT_LABEL: Record<(typeof CODEX_EVENTS)[number], CodexEventLabel> = {
  SessionStart: CODEX_HOOK_EVENT_LABEL.SessionStart!,
  UserPromptSubmit: CODEX_HOOK_EVENT_LABEL.UserPromptSubmit!,
  PreToolUse: CODEX_HOOK_EVENT_LABEL.PreToolUse!,
  PermissionRequest: CODEX_HOOK_EVENT_LABEL.PermissionRequest!,
  PostToolUse: CODEX_HOOK_EVENT_LABEL.PostToolUse!,
  SubagentStart: CODEX_HOOK_EVENT_LABEL.SubagentStart!,
  SubagentStop: CODEX_HOOK_EVENT_LABEL.SubagentStop!,
  Stop: CODEX_HOOK_EVENT_LABEL.Stop!,
  Interrupt: CODEX_HOOK_EVENT_LABEL.Interrupt!
}

// Clamp to Codex's per-event timeout caps (Interrupt: 3s) to avoid startup warnings.
export function buildCodexManagedHook(
  command: string,
  eventName: (typeof CODEX_EVENTS)[number]
): HookCommandConfig {
  return buildManagedCommandHook(
    command,
    normalizeCodexHookTimeoutSec(CODEX_EVENT_LABEL[eventName], MANAGED_HOOK_TIMEOUT_SECONDS)
  )
}

export const CODEX_MANAGED_EVENT_LABELS = new Set<CodexEventLabel>(
  CODEX_EVENTS.map((eventName) => CODEX_EVENT_LABEL[eventName])
)

/** Local hashes stand in until Codex returns its own. */
export function computeOrcaCodexHookHashes(
  command: string = getManagedCommand(getManagedScriptPath())
): CodexHookHashes {
  return Object.fromEntries(
    CODEX_EVENTS.map((eventName) => {
      const eventLabel = CODEX_EVENT_LABEL[eventName]
      return [
        eventLabel,
        computeCodexTrustedHash({
          sourcePath: '',
          eventLabel,
          groupIndex: 0,
          handlerIndex: 0,
          command,
          timeoutSec: buildCodexManagedHook(command, eventName).timeout
        })
      ]
    })
  )
}

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
  return buildCodexHookCommand(scriptPath)
}

export type CodexManagedHookInstallMaterial = {
  events: readonly (typeof CODEX_EVENTS)[number][]
  eventLabel: Record<(typeof CODEX_EVENTS)[number], CodexEventLabel>
  scriptPath: string
  command: string
  script: string
}

// Real and managed homes must use identical hook material to keep trust signatures equal.
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
  const quoted = quotePosixShell(scriptPath)
  // /bin/sh avoids unreliable WSL/UNC exec bits; missing scripts must still drain stdin.
  return `if [ -f ${quoted} ] && [ -r ${quoted} ]; then /bin/sh ${quoted}; else ${POSIX_HOOK_STDIN_DRAIN_COMMAND}; fi`
}

export function getSystemConfigPath(): string {
  return join(getSystemCodexHomePath(), 'hooks.json')
}

export function getSystemCodexConfigTomlPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}
