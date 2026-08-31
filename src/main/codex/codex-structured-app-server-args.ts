import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'

const VALUE_FLAGS = new Set([
  '-a',
  '--add-dir',
  '--ask-for-approval',
  '-c',
  '--config',
  '--disable',
  '--effort',
  '--enable',
  '--local-provider',
  '-m',
  '--model',
  '-p',
  '--profile',
  '--reasoning-effort',
  '-s',
  '--sandbox'
])

const BOOLEAN_FLAGS = new Set([
  '--approve-for-me',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--oss',
  '--search',
  '--strict-config'
])

const EFFORT_FLAGS = new Set(['--effort', '--reasoning-effort'])

function configuredArgsError(detail: string): Error {
  return new Error(
    `Structured Codex chat cannot apply the configured CLI arguments to app-server: ${detail}. Update Codex CLI arguments in Settings or use terminal view.`
  )
}

function splitOption(token: string): { flag: string; inlineValue?: string } {
  const separator = token.indexOf('=')
  return separator > 0
    ? { flag: token.slice(0, separator), inlineValue: token.slice(separator + 1) }
    : { flag: token }
}

/** Keeps config-affecting Codex flags and refuses every TUI-only or unknown token visibly. */
export function resolveCodexStructuredAppServerArgs(
  configuredArgs: string,
  shell: AgentStartupShell
): string[] {
  const parsed = tokenizeStartupCommand(configuredArgs.trim(), shell)
  if (!parsed.ok) {
    throw configuredArgsError(parsed.error)
  }
  const divergent = parsed.spans.find((span) => span.divergesFromShell)
  if (divergent) {
    throw configuredArgsError(configuredArgs.slice(divergent.start, divergent.end))
  }
  const result: string[] = []
  for (let index = 0; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index]
    const { flag, inlineValue } = splitOption(token)
    if (BOOLEAN_FLAGS.has(flag) && inlineValue === undefined) {
      result.push(flag)
      continue
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw configuredArgsError(token || 'an empty positional argument')
    }
    const value = inlineValue ?? parsed.tokens[++index]
    if (value === undefined || value.length === 0) {
      throw configuredArgsError(`${flag} requires a value`)
    }
    if (EFFORT_FLAGS.has(flag)) {
      result.push('-c', `model_reasoning_effort=${value}`)
    } else {
      result.push(flag, value)
    }
  }
  return result
}
