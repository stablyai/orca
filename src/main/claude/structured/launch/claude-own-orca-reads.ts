// Orca's prompts name this session's CLI as `"${ORCA_CLI_COMMAND:-orca}"`. Claude asks before any
// command with a variable in braces and offers no rule to remember it by, so without this every
// Orca read in an Ask for approval chat waits on a prompt.
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { ownOrcaReadsOnly } from '../../../bots/bot-look-around-policy'
import type { ClaudeStructuredSdkOptions } from './claude-structured-launch-resolution'

/** Modes where such a read would otherwise ask; Plan, Auto, dontAsk and bypass keep their own answer. */
const ASKING_MODES: ReadonlySet<string> = new Set(['default', 'acceptEdits'])

function ownOrcaReadsHook(cliResolved: boolean): HookCallback {
  return async (input) => {
    if (
      !cliResolved ||
      input.hook_event_name !== 'PreToolUse' ||
      input.tool_name !== 'Bash' ||
      !ASKING_MODES.has(input.permission_mode ?? '')
    ) {
      return {}
    }
    const toolInput: unknown = input.tool_input
    if (typeof toolInput !== 'object' || toolInput === null || !('command' in toolInput)) {
      return {}
    }
    // A retry outside the sandbox stays the owner's call.
    const unsandboxed =
      'dangerouslyDisableSandbox' in toolInput && toolInput.dangerouslyDisableSandbox === true
    return !unsandboxed && ownOrcaReadsOnly(toolInput.command)
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
      : {}
  }
}

/** Orca answers its own reads only where the variable names this app's CLI (unset, the shell runs
 *  whatever `orca` PATH finds) and off Windows, whose prompts use a bare `orca` Claude can check.
 *  The hook is always registered, so a kept agent reattached by a later launch still finds it.
 *  A read-only run's own hook already decides every call. */
export function withOwnOrcaReads(
  options: ClaudeStructuredSdkOptions,
  env: Readonly<Record<string, string>> | undefined,
  platform: NodeJS.Platform = process.platform
): ClaudeStructuredSdkOptions {
  if (options.hooks || platform === 'win32') {
    return options
  }
  const hook = ownOrcaReadsHook(Boolean(env?.ORCA_CLI_COMMAND))
  return { ...options, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }] } }
}
