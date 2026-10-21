import {
  workInboxCliServer,
  WORK_INBOX_TOOL_NAMES,
  WORK_INBOX_CALLER_KEYS
} from '../runtime/work-inbox/work-inbox-cli-launch'
import { resolve, win32 } from 'node:path'
import { hasAppEnvironment } from '../../shared/app-environment'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { codexWorkInboxDeveloperInstructions } from './codex-work-inbox-instructions'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { commandLineLength, MAX_COMMAND_LINE_CHARS } from '../../shared/windows-command-line-budget'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'

/** Invocation-only: never promote this entry or a caller identity into a Codex home. */
export function codexWorkInboxLaunchArgs(): string[] {
  if (!hasAppEnvironment()) {
    return []
  }
  const server = {
    ...workInboxCliServer(),
    env_vars: [...WORK_INBOX_CALLER_KEYS],
    enabled_tools: [...WORK_INBOX_TOOL_NAMES],
    tools: Object.fromEntries(
      WORK_INBOX_TOOL_NAMES.map((name) => [name, { approval_mode: 'approve' }])
    ),
    enabled: true,
    required: true,
    startup_timeout_sec: 15,
    tool_timeout_sec: 60
  }
  return ['-c', `mcp_servers.orca_work_inbox=${tomlValue(server)}`]
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(tomlValue).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${key}=${tomlValue(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function withCodexWorkInboxCommand(input: {
  command: string | undefined
  agent: string | undefined
  shell: AgentStartupShell
  remote: boolean
  serverIsolation?: string
}): string | undefined {
  if (!input.command || input.agent !== 'codex') {
    return input.command
  }
  if (input.remote) {
    return input.command
  }
  const parsed = tokenizeStartupCommand(input.command, input.shell)
  const executable = parsed.ok ? parsed.spans[0] : undefined
  if (
    parsed.ok &&
    parsed.tokens.some((token) => token === '--remote' || token.startsWith('--remote='))
  ) {
    throw new Error(
      'Orca Work Inbox cannot route a Codex remote app-server through this local host.'
    )
  }
  if (input.serverIsolation === '0') {
    throw new Error(
      'Orca Work Inbox requires Codex terminal server isolation to preserve the asking agent identity. Enable Codex terminal server isolation before launching.'
    )
  }
  if (
    !parsed.ok ||
    !executable ||
    executable.divergesFromShell ||
    !/^codex(?:\.(?:exe|cmd|bat|ps1))?$/i.test(win32.basename(parsed.tokens[0]))
  ) {
    throw new Error('Orca Work Inbox cannot configure this Codex command override safely.')
  }
  const args = codexWorkInboxLaunchArgs()
    .map((arg) => quoteStartupArg(arg, input.shell))
    .join(' ')
  const terminator = parsed.tokens.indexOf('--')
  const at = terminator !== -1 ? parsed.spans[terminator].start : input.command.length
  return args
    ? `${input.command.slice(0, at)} ${args} ${input.command.slice(at)}`.trim()
    : input.command
}

export async function prepareCodexWorkInboxCommand(
  input: Parameters<typeof withCodexWorkInboxCommand>[0] & {
    cwd?: string
    env?: Record<string, string>
    envToDelete?: readonly string[]
    codexHome?: string | null
  }
): Promise<{ command: string | undefined; env: Record<string, string> | undefined }> {
  const command = withCodexWorkInboxCommand(input)
  if (input.remote || !command || input.agent !== 'codex' || !hasAppEnvironment()) {
    return { command, env: input.env }
  }
  if (input.shell === 'cmd' || input.shell === 'powershell') {
    throw new Error(
      'Orca Work Inbox terminal instruction delivery requires a POSIX shell. Use native chat or a POSIX terminal; Windows shell quoting cannot yet preserve these instructions safely.'
    )
  }
  const parsed = tokenizeStartupCommand(command, input.shell)
  if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell)) {
    throw new Error('Orca Work Inbox could not safely resolve the Codex launch arguments.')
  }
  const env = {
    ...process.env,
    ...input.env,
    ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {})
  }
  for (const key of input.envToDelete ?? []) {
    delete env[key]
  }
  const cwd = codexLaunchWorkingDirectory(parsed.tokens.slice(1), input.cwd ?? process.cwd())
  const binary = await resolveCommandOnLocalPath(parsed.tokens[0], { env, cwd })
  if (!binary) {
    throw new Error('Orca Work Inbox could not resolve the Codex executable.')
  }
  const args = codexConfigReadArgs(parsed.tokens.slice(1))
  const connection = await openCodexAppServerConnection({
    command: binary,
    args: [...args, ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
    cwd,
    env
  })
  let instructions: string
  let closed = false
  try {
    instructions = await codexWorkInboxDeveloperInstructions(connection, cwd)
  } finally {
    closed = await connection.close()
  }
  if (!closed) {
    throw new Error(
      'Orca could not confirm the Codex config reader stopped; launch was not continued.'
    )
  }
  const instructionArg = `developer_instructions=${JSON.stringify(instructions)}`
  if (
    process.platform === 'win32' &&
    commandLineLength([...parsed.tokens, '-c', instructionArg]) > MAX_COMMAND_LINE_CHARS
  ) {
    throw new Error(
      'Codex launch instructions exceed the Windows command-line limit; shorten the launch prompt or configured instructions before retrying.'
    )
  }
  // Keep user instructions out of the typed command and terminal history.
  const suffix = '-c "$ORCA_CODEX_INBOX_INSTRUCTIONS"'
  const terminator = parsed.tokens.indexOf('--')
  const at = terminator !== -1 ? parsed.spans[terminator].start : command.length
  return {
    command: `${command.slice(0, at)} ${suffix} ${command.slice(at)}`.trim(),
    env: { ...input.env, ORCA_CODEX_INBOX_INSTRUCTIONS: instructionArg }
  }
}

export function codexLaunchWorkingDirectory(tokens: readonly string[], cwd: string): string {
  let effective = cwd
  for (let index = 0; index < tokens.length && tokens[index] !== '--'; index += 1) {
    const token = tokens[index]
    const value =
      token === '-C' || token === '--cd'
        ? tokens[++index]
        : token.startsWith('--cd=')
          ? token.slice(5)
          : token.startsWith('-C')
            ? token.slice(2)
            : null
    if (value !== null) {
      if (!value) {
        throw new Error('Codex working-directory option is missing its value.')
      }
      effective = resolve(cwd, value)
    }
  }
  return effective
}

export function codexConfigReadArgs(tokens: readonly string[]): string[] {
  const args: string[] = []
  for (let index = 0; index < tokens.length && tokens[index] !== '--'; index += 1) {
    const token = tokens[index]
    if (['-c', '--config', '-p', '--profile', '--enable', '--disable'].includes(token)) {
      const value = tokens[++index]
      if (!value) {
        throw new Error('Codex configuration option is missing its value.')
      }
      args.push(token, value)
    } else if (
      /^(?:--(?:config|profile|enable|disable)=|-[cp].+)/.test(token) ||
      token === '--ignore-user-config'
    ) {
      args.push(token)
    }
  }
  return args
}
