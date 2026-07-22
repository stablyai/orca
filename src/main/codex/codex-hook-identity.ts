import type { HookCommandConfig, HookDefinition } from '../agent-hooks/installer-utils'
import type { CodexEventLabel, CodexTrustEntry } from './config-toml-trust'

// Why: Codex's trust hash key uses the snake_case event label (see
// codex-rs/hooks/src/lib.rs::hook_event_key_label) while hooks.json uses the
// PascalCase serde-rename. Keep the mapping in one shared module so the
// install, status, and write-back promotion paths cannot drift.
export const CODEX_HOOK_EVENT_LABEL: Record<string, CodexEventLabel> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact'
}

export const CODEX_EVENT_NAME_BY_LABEL: Record<CodexEventLabel, string> = {
  session_start: 'SessionStart',
  user_prompt_submit: 'UserPromptSubmit',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
  pre_tool_use: 'PreToolUse',
  permission_request: 'PermissionRequest',
  post_tool_use: 'PostToolUse',
  stop: 'Stop',
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

// Why: identity of a hook's content independent of file position, used to
// match the same hook across the system and runtime hooks.json layouts
// (dedupe and the prepended managed hook shift positions between them).
export function getCodexHookTrustSignature(entry: CodexTrustEntry): string {
  return JSON.stringify({
    eventLabel: entry.eventLabel,
    command: entry.command,
    timeoutSec: Math.max(1, entry.timeoutSec ?? 600),
    async: entry.async ?? false,
    matcher: entry.matcher ?? null,
    statusMessage: entry.statusMessage ?? null
  })
}
