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
const PERMISSION_CONFIG_KEYS = new Map([
  ['-a', 'approval_policy'],
  ['--ask-for-approval', 'approval_policy'],
  ['-s', 'sandbox_mode'],
  ['--sandbox', 'sandbox_mode']
])

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
  return resolveCodexStructuredAppServerArgv(parsed.tokens)
}

export function resolveCodexStructuredAppServerArgv(tokens: readonly string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const { flag, inlineValue } = splitOption(token)
    // Codex accepts the TUI bypass flag before app-server but does not apply it.
    if (flag === '--dangerously-bypass-approvals-and-sandbox' && inlineValue === undefined) {
      result.push('-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"')
      continue
    }
    if (BOOLEAN_FLAGS.has(flag) && inlineValue === undefined) {
      result.push(flag)
      continue
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw configuredArgsError(token || 'an empty positional argument')
    }
    const value = inlineValue ?? tokens[++index]
    if (value === undefined || value.length === 0) {
      throw configuredArgsError(`${flag} requires a value`)
    }
    const permissionKey = PERMISSION_CONFIG_KEYS.get(flag)
    if (permissionKey) {
      result.push('-c', `${permissionKey}=${JSON.stringify(value)}`)
    } else if (EFFORT_FLAGS.has(flag)) {
      result.push('-c', `model_reasoning_effort=${value}`)
    } else {
      result.push(flag, value)
    }
  }
  return result
}
