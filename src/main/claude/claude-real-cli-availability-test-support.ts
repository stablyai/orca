// Whether a real, signed-in Claude CLI may be used — the gate every real-CLI
// suite skips on. Opt-in only; probed once per test process.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync, type ProcessResult } from '../../shared/child-process/run-process'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { CLAUDE_AUTH_ENV_VARS } from '../claude-accounts/environment'
import { resolveClaudeCommand } from '../codex-cli/command'
import { resolveRealClaudeCliGate } from './claude-real-cli-test-gate'

export const realClaudeCommand = resolveClaudeCommand()

// Why paired: the probe must run the CLI under the same node the structured launch gives it.
function probeRealClaude(args: string[]): ProcessResult | null {
  try {
    return runProcessSync({
      program: realClaudeCommand,
      args,
      env: withCliRuntimeOnPath(realClaudeCommand, process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: 5_000
    })
  } catch {
    return null
  }
}

// Why the gate: an installed, signed-in CLI is not consent to spend turns on that account, so
// nothing is probed unless the run opted in.
export const realClaudeCliGate = resolveRealClaudeCliGate(process.env, (args) => {
  const result = probeRealClaude([...args])
  return { status: result?.code ?? null, stdout: result?.stdout ?? '' }
})

export const realClaudeAvailable = realClaudeCliGate.skipReason === null

/** The CLI's own account report — the only source of truth for where it writes that
 *  is not derived from Orca's own path expressions. */
export const realClaudeAuthStatus = realClaudeCliGate.authStatus

export const realClaudeAuthenticated = realClaudeAuthStatus?.loggedIn === true

/** The config dir and env auth the availability probe above saw, for a real-CLI launch.
 *  The connection strips an inherited CLAUDE_CONFIG_DIR and inherited auth vars, so
 *  without these the child silently runs against ~/.claude whatever the probe checked. */
export function realClaudeLaunchHome(): { claudeConfigDir: string; env: Record<string, string> } {
  const env: Record<string, string> = {}
  for (const key of CLAUDE_AUTH_ENV_VARS) {
    const value = process.env[key]
    if (value) {
      env[key] = value
    }
  }
  return {
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'),
    env
  }
}
