import type {
  HookCommandConfig,
  HookDefinition
} from '../../../agent-hooks/installation/configuration/hook-config-schema'
import type { CodexEventLabel, CodexTrustEntry } from '../../trust/toml/config-toml-trust'
import { normalizeCodexHookTimeoutSec } from '../../trust/identity/codex-trust-identity'

// Codex trust keys use snake_case event labels; hooks.json uses PascalCase.
export const CODEX_HOOK_EVENT_LABEL: Record<string, CodexEventLabel> = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
  Interrupt: 'interrupt',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact'
}

export const CODEX_EVENT_NAME_BY_LABEL: Record<CodexEventLabel, string> = {
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
  user_prompt_submit: 'UserPromptSubmit',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
  pre_tool_use: 'PreToolUse',
  permission_request: 'PermissionRequest',
  post_tool_use: 'PostToolUse',
  stop: 'Stop',
  interrupt: 'Interrupt',
  pre_compact: 'PreCompact',
  post_compact: 'PostCompact'
}

export function getCodexManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
}

export function createCodexHookTrustEntry(
  sourcePath: string,
  eventName: string,
  groupIndex: number,
  handlerIndex: number,
  definition: HookDefinition,
  hook: HookCommandConfig
): CodexTrustEntry | null {
  const eventLabel = CODEX_HOOK_EVENT_LABEL[eventName]
  if (!eventLabel || !hook.command) {
    return null
  }

  return {
    sourcePath,
    eventLabel,
    groupIndex,
    handlerIndex,
    command: hook.command,
    ...(typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {}),
    ...(typeof hook.async === 'boolean' ? { async: hook.async } : {}),
    ...(typeof definition.matcher === 'string' ? { matcher: definition.matcher } : {}),
    ...(typeof hook.statusMessage === 'string' ? { statusMessage: hook.statusMessage } : {})
  }
}

// Match content across homes despite position shifts from deduplication and prepended managed hooks.
export function getCodexHookTrustSignature(entry: CodexTrustEntry): string {
  return JSON.stringify({
    eventLabel: entry.eventLabel,
    command: entry.command,
    timeoutSec: normalizeCodexHookTimeoutSec(entry.eventLabel, entry.timeoutSec),
    async: entry.async ?? false,
    matcher: entry.matcher ?? null,
    statusMessage: entry.statusMessage ?? null
  })
}

// Mirroring only: the runtime copy keeps raw timeouts, and clamped-equal hooks can carry different trust.
export function getCodexUserHookMirrorSignature(entry: CodexTrustEntry): string {
  return JSON.stringify([getCodexHookTrustSignature(entry), entry.timeoutSec ?? null])
}
