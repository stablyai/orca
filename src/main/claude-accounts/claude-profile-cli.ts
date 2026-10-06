// Scoped Keychain support is required before a managed home can own macOS auth.
import { runProcess } from '../../shared/child-process/run-process'
import { isAbsolute } from 'node:path'
import { resolveClaudeCommand } from '../../shared/node-cli-command-resolution'
import { quoteStartupArg, tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { CLAUDE_AUTH_ENV_VARS } from './environment'
import { CLAUDE_PROFILE_PROVIDER_ENV_VARS } from './claude-profile-environment'

/** Apply credential authority after interactive shell startup files have run. */
export function bindClaudeProfileTerminalEnvironment(
  command: string | undefined,
  auth: { isolatedCredentials?: boolean; configDir: string } | null | undefined
): string | undefined {
  if (!auth?.isolatedCredentials || !command) {
    return command
  }
  const deletions = [
    ...CLAUDE_AUTH_ENV_VARS,
    ...CLAUDE_PROFILE_PROVIDER_ENV_VARS,
    'ANTHROPIC_CUSTOM_HEADERS'
  ]
    .map((key) => `-u ${key}`)
    .join(' ')
  return `/usr/bin/env ${deletions} ${quoteStartupArg(`CLAUDE_CONFIG_DIR=${auth.configDir}`, 'posix')} ${command}`
}

export function supportsClaudeProfileKeychain(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version.trim())
  return Boolean(
    match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 1))
  )
}

export async function assertClaudeProfileCli(command = resolveClaudeCommand()): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  const result = await runProcess({
    program: command,
    args: ['--version'],
    timeoutMs: 5000,
    maxOutputBytes: 8192,
    killOnOutputLimit: true
  })
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.outputTruncated ||
    !supportsClaudeProfileKeychain(result.stdout)
  ) {
    throw new Error(
      'Claude profiles on macOS require Claude Code 2.1 or later. Update Claude Code before launching this profile.'
    )
  }
}

export async function pinClaudeProfileTerminalCommand(
  command: string | undefined,
  env?: Record<string, string>
): Promise<string | undefined> {
  if (process.platform === 'win32') {
    throw new Error('Claude launch profiles currently require macOS or Linux.')
  }
  const parsed = tokenizeStartupCommand(command ?? '', 'posix')
  if (
    !parsed.ok ||
    !parsed.tokens.length ||
    parsed.spans.some((span) => span.divergesFromShell) ||
    /[\r\n\0]/.test(command ?? '')
  ) {
    throw new Error(
      'Claude profiles require a direct Claude command; shell wrappers are not supported.'
    )
  }
  const first = parsed.tokens[0]
  const binary =
    first === 'claude' ? resolveClaudeCommand({ pathEnv: env?.PATH ?? process.env.PATH }) : first
  if (!isAbsolute(binary) || !binary.endsWith('/claude')) {
    throw new Error('Claude profiles require a direct Claude executable path.')
  }
  await assertClaudeProfileCli(binary)
  return `${quoteStartupArg(binary, 'posix')}${command!.slice(parsed.spans[0].end)}`
}
