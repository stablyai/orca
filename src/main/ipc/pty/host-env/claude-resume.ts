import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import { normalizeAgentProviderSession } from '../../../../shared/agent-session-resume'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../../../shared/claude-profile-routing'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'
import { getPowerShellEscapeNativeArgsFunction } from '../../../../shared/powershell-native-argument'
import {
  buildShellCommandFromArgv,
  quoteStartupArg,
  tokenizeStartupCommand,
  withoutEnvCommand,
  type AgentStartupShell
} from '../../../../shared/tui-agent-startup-shell'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ClaudeSessionResumePreparation } from '../../../claude/claude-session-resume-config'
import type { ClaudeAccountSelectionTarget } from '../../../claude-accounts/runtime-selection'

const ROUTING_ENV = [
  'CLAUDE_CONFIG_DIR',
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
] as const

export class ClaudeSessionResumeUnavailableError extends Error {
  readonly code = 'claude_resume_unavailable'

  constructor(reason: string) {
    super(
      `Claude session could not be restored (${reason}). The recovery record is kept; resume it manually with its original account and configuration.`
    )
    this.name = 'ClaudeSessionResumeUnavailableError'
  }
}

export type PrepareClaudeSessionResume = (args: {
  providerSession: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
  launchEnv?: Record<string, string>
  target: ClaudeAccountSelectionTarget
}) => Promise<ClaudeSessionResumePreparation>

export function isClaudeResumeRequest(
  agent: TuiAgent | undefined,
  metadata: AgentProviderSessionMetadata | undefined
): boolean {
  return agent === 'claude' && normalizeAgentProviderSession(metadata) !== null
}

function hasUnmodelledExpansion(value: string, shell: AgentStartupShell): boolean {
  let quote: string | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === "'") {
      if (char === "'") {
        if (shell === 'powershell' && value[index + 1] === "'") {
          index += 1
        } else {
          quote = null
        }
      }
    } else if (char === (shell === 'powershell' ? '`' : '\\')) {
      index += 1
    } else if (char === '$' || char === '`' || (!quote && '~*?[]{}'.includes(char))) {
      return true
    } else if (quote === '"' && char === '"') {
      quote = null
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char
    }
  }
  return false
}

function checkedClaudeCommandArgv(
  command: string,
  sessionId: string,
  shell: AgentStartupShell
): string[] | null {
  if (hasUnmodelledExpansion(command, shell)) {
    return null
  }
  if (shell === 'powershell' && /[\u2018\u2019\u201a\u201b\u201c\u201d\u201e]/.test(command)) {
    return null
  }
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok) {
    return null
  }
  const { tokens, spans } = parsed
  for (let index = 0; index <= tokens.length; index += 1) {
    const start = index === 0 ? 0 : spans[index - 1].end
    const end = index === tokens.length ? command.length : spans[index].start
    if (!/^[ \t]*$/.test(command.slice(start, end))) {
      return null
    }
    if (index < tokens.length && spans[index].divergesFromShell) {
      if (!(shell === 'powershell' && index === 0 && tokens[index] === '&')) {
        return null
      }
    }
  }
  const argv = shell === 'powershell' && tokens[0] === '&' ? tokens.slice(1) : tokens
  const executable = argv[0]?.replace(/\\/g, '/').split('/').pop()
  if (!executable || !/^claude(?:\.(?:exe|cmd|bat|ps1))?$/i.test(executable)) {
    return null
  }
  const terminator = argv.indexOf('--')
  const options = terminator === -1 ? argv : argv.slice(0, terminator)
  if (
    options.some(
      (token) => token === '--continue' || token === '-c' || token.startsWith('--continue=')
    )
  ) {
    return null
  }
  const selectors = options.flatMap((token, index) =>
    token === '--resume' || token === '-r'
      ? [options[index + 1]]
      : token.startsWith('--resume=')
        ? [token.slice('--resume='.length)]
        : []
  )
  return selectors.length === 1 && selectors[0] === sessionId ? argv : null
}

function bindClaudeCommand(
  command: string,
  sessionId: string,
  preparation: Extract<ClaudeSessionResumePreparation, { outcome: 'resume' }>,
  shell: AgentStartupShell
): string {
  const argv = checkedClaudeCommandArgv(command, sessionId, shell)
  if (!argv || shell === 'cmd') {
    throw new ClaudeSessionResumeUnavailableError('unsupported-command')
  }
  const invocation = buildShellCommandFromArgv(argv, shell)
  if (shell === 'posix') {
    const assignment =
      preparation.configDir === null
        ? ''
        : `CLAUDE_CONFIG_DIR=${quoteStartupArg(preparation.configDir, shell)} `
    return withoutEnvCommand(
      ROUTING_ENV,
      `HOME=${quoteStartupArg(preparation.userHome, shell)} ${assignment}${invocation}`,
      shell
    )
  }
  const scopedEnv = [...ROUTING_ENV, 'HOME', 'USERPROFILE']
  const saved = scopedEnv
    .map(
      (name) =>
        `${quoteStartupArg(name, shell)}=[Environment]::GetEnvironmentVariable(${quoteStartupArg(name, shell)}, 'Process')`
    )
    .join('; ')
  const clear = scopedEnv
    .map(
      (name) =>
        `Remove-Item -LiteralPath ${quoteStartupArg(`Env:${name}`, shell)} -ErrorAction SilentlyContinue`
    )
    .join('; ')
  const assignment =
    preparation.configDir === null
      ? ''
      : `[Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', ${quoteStartupArg(preparation.configDir, shell)}, 'Process'); `
  const executable = /[\\/]/.test(argv[0])
    ? quoteStartupArg(argv[0], shell)
    : `(Get-Command -Name ${quoteStartupArg(argv[0], shell)} -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1).Source`
  const args = argv
    .slice(1)
    .map((arg) => quoteStartupArg(arg, shell))
    .join(', ')
  const adapter = quoteStartupArg(
    getPowerShellEscapeNativeArgsFunction().replace('Global:', ''),
    shell
  )
  const invoke = `. ([ScriptBlock]::Create(${adapter})); $orcaClaudeResumeBinary=${executable}; $orcaClaudeResumeArgs=@(__OrcaEscapeNativeArgs $orcaClaudeResumeBinary @(${args})); & $orcaClaudeResumeBinary @orcaClaudeResumeArgs`
  const home = quoteStartupArg(preparation.userHome, shell)
  return `& { $orcaClaudeResumeEnv=@{${saved}}; try { ${clear}; $env:HOME=${home}; $env:USERPROFILE=${home}; ${assignment}${invoke} } finally { foreach ($orcaClaudeResumeName in $orcaClaudeResumeEnv.Keys) { if ($null -eq $orcaClaudeResumeEnv[$orcaClaudeResumeName]) { Remove-Item -LiteralPath "Env:$orcaClaudeResumeName" -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($orcaClaudeResumeName, $orcaClaudeResumeEnv[$orcaClaudeResumeName], 'Process') } } } }`
}

export async function resolveClaudeResumeLaunch(args: {
  command: string | undefined
  env: Record<string, string> | undefined
  providerSession: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
  shell: AgentStartupShell
  target: ClaudeAccountSelectionTarget
  prepare: PrepareClaudeSessionResume | undefined
}): Promise<{ command: string | undefined; env: Record<string, string> | undefined }> {
  const prepared = await args.prepare?.({
    providerSession: args.providerSession,
    launchConfig: args.launchConfig,
    launchEnv: args.env,
    target: args.target
  })
  if (prepared?.outcome !== 'resume') {
    throw new ClaudeSessionResumeUnavailableError(prepared?.reason ?? 'unknown-store')
  }
  const sequenced = args.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
  if (sequenced) {
    return {
      command: args.command,
      env: {
        ...args.env,
        [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: bindClaudeCommand(
          sequenced,
          args.providerSession.id,
          prepared,
          args.shell
        )
      }
    }
  }
  if (!args.command) {
    throw new ClaudeSessionResumeUnavailableError('missing-command')
  }
  return {
    command: bindClaudeCommand(args.command, args.providerSession.id, prepared, args.shell),
    env: args.env
  }
}
