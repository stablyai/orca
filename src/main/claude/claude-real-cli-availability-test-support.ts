import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { CLAUDE_AUTH_ENV_VARS } from '../claude-accounts/environment'
import { resolveClaudeCommand } from '../codex-cli/command'
import { resolveRealClaudeCliGate } from './claude-real-cli-test-gate'

export const realClaudeCommand = resolveClaudeCommand()

// Match structured launches by using the CLI's paired Node runtime.
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

export const realClaudeCliGate = resolveRealClaudeCliGate(process.env, (args) => {
  const result = probeRealClaude([...args])
  return { status: result?.code ?? null, stdout: result?.stdout ?? '' }
})

export const realClaudeAvailable = realClaudeCliGate.skipReason === null

/** Use the CLI's account report as an independent oracle for transcript paths. */
export const realClaudeAuthStatus = realClaudeCliGate.authStatus

export const realClaudeAuthenticated = realClaudeAuthStatus?.loggedIn === true

/** Restore the probed home and auth explicitly: connections strip inherited account state. */
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
