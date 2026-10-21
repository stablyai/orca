import { WORK_INBOX_CLI_PROMPT } from '../../../shared/work-inbox-routing-instructions'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'
import { TUI_AGENT_CONFIG, isTuiAgent } from '../../../shared/tui-agent-config'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'

export const WORK_INBOX_TOOL_NAMES = ['ask_user', 'wait_for_answer', 'acknowledge_answer'] as const
export const WORK_INBOX_CALLER_KEYS = [
  'ORCA_TERMINAL_HANDLE',
  'ORCA_AGENT_SESSION_ID',
  'ORCA_AGENT_SESSION_SPAWN_TOKEN',
  'ORCA_STRUCTURED_SESSION'
] as const

/** The tool bridge exposes the same CLI to agents whose file-only tool policy has no shell. */
export async function prepareWorkInboxCliLaunch(input: {
  command?: string
  agent?: string
  shell: AgentStartupShell
  remote: boolean
  env?: Record<string, string>
}): Promise<string | undefined> {
  if (
    !input.command ||
    !input.agent ||
    !isTuiAgent(input.agent) ||
    TUI_AGENT_CONFIG[input.agent].builtinToolsLaunch !== 'mcp-json' ||
    !hasAppEnvironment()
  ) {
    return input.command
  }
  if (input.remote) {
    // The remote host supplies its own CLI; a desktop path must never cross that boundary.
    return input.command
  }
  const prefix = input.shell === 'powershell' ? (input.command.match(/^\s*&\s+/)?.[0] ?? '') : ''
  let line = input.command.slice(prefix.length)
  const parsed = tokenizeStartupCommand(line, input.shell)
  if (
    !parsed.ok ||
    parsed.spans.some((s) => s.divergesFromShell) ||
    win32
      .basename(parsed.tokens[0] ?? '')
      .replace(/\.(exe|cmd|bat|ps1)$/i, '')
      .toLowerCase() !== TUI_AGENT_CONFIG[input.agent].expectedProcess.toLowerCase()
  ) {
    throw new Error('Orca cannot safely attach its built-in CLI to this agent command override.')
  }
  const config = { mcpServers: { orca_work_inbox: workInboxCliServer(input.env) } }
  const app = getAppEnvironment()
  const key = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  const folder = join(app.getPath('userData'), 'work-inbox', 'builtin-tools')
  const file = join(folder, `${key}.json`)
  await mkdir(folder, { recursive: true })
  await writeFile(file, JSON.stringify(config), { mode: 0o600 })
  const appendAt = parsed.tokens.indexOf('--append-system-prompt')
  const inlineAppendAt = parsed.tokens.findIndex((token) =>
    token.startsWith('--append-system-prompt=')
  )
  const hasPromptFile = parsed.tokens.some(
    (token) =>
      token === '--append-system-prompt-file' || token.startsWith('--append-system-prompt-file=')
  )
  const systemFlags: string[] = []
  if (appendAt !== -1 && parsed.spans[appendAt + 1]) {
    const span = parsed.spans[appendAt + 1]
    const current = parsed.tokens[appendAt + 1]
    line =
      line.slice(0, span.start) +
      quoteStartupArg(current + ' ' + WORK_INBOX_CLI_PROMPT, input.shell) +
      line.slice(span.end)
  } else if (inlineAppendAt !== -1) {
    const span = parsed.spans[inlineAppendAt]
    const value = `${parsed.tokens[inlineAppendAt]} ${WORK_INBOX_CLI_PROMPT}`
    line = line.slice(0, span.start) + quoteStartupArg(value, input.shell) + line.slice(span.end)
  } else if (!hasPromptFile) {
    systemFlags.push('--append-system-prompt', WORK_INBOX_CLI_PROMPT)
  }
  const flags = [
    ...systemFlags,
    '--mcp-config',
    file,
    '--allowedTools',
    ...WORK_INBOX_TOOL_NAMES.map((tool) => `mcp__orca_work_inbox__${tool}`)
  ]
    .map((arg) => quoteStartupArg(arg, input.shell))
    .join(' ')
  const terminator = parsed.tokens.indexOf('--')
  const updated = tokenizeStartupCommand(line, input.shell)
  if (!updated.ok) {
    throw new Error('Invalid built-in Inbox launch command')
  }
  const at = terminator === -1 ? line.length : updated.spans[terminator].start
  return `${prefix}${line.slice(0, at)} ${flags} ${line.slice(at)}`.trim()
}

export const WORK_INBOX_ALLOWED_TOOLS = WORK_INBOX_TOOL_NAMES.map(
  (tool) => `mcp__orca_work_inbox__${tool}`
)

export function workInboxCliServer(env?: Record<string, string>) {
  const app = getAppEnvironment()
  const cli = join(
    app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
    'out',
    'cli',
    'index.js'
  )
  if (!existsSync(cli)) {
    throw new Error('Orca built-in Inbox CLI is missing; repair this Orca installation.')
  }
  const identity: Record<string, string> = {}
  if (env) {
    for (const key of WORK_INBOX_CALLER_KEYS) {
      if (key === 'ORCA_TERMINAL_HANDLE' && env[key] === undefined && !env.ORCA_AGENT_SESSION_ID) {
        continue
      }
      identity[key] = env[key] ?? ''
    }
  }
  return {
    command: process.execPath,
    args: [cli, 'inbox', 'mcp'],
    env: {
      ...identity,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '',
      NODE_REPL_EXTERNAL_MODULE: '',
      ORCA_USER_DATA_PATH: app.getPath('userData'),
      ORCA_ENVIRONMENT: '',
      ORCA_PAIRING_CODE: '',
      ORCA_REMOTE_PAIRING: ''
    }
  }
}
