// Pin argv before provider launch planning; bind credentials only after shell startup.
import { isAbsolute } from 'node:path'
import { CODEX_PROFILE_FILE_AUTH_ARGS } from '../codex-accounts/profile-config-authority'
import { quoteStartupArg, tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import type { PreparedAgentProfile } from './connection-contracts'

function assertExternalClaudeSettings(value: string | undefined): void {
  let settings: unknown
  try {
    settings = JSON.parse(value ?? '')
  } catch {
    throw new Error(
      'External Claude settings must be inline JSON so the pinned home can be validated.'
    )
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('External Claude settings must be an object.')
  }
  if (!('env' in settings)) {
    return
  }
  const env = settings.env
  if (
    !env ||
    typeof env !== 'object' ||
    Array.isArray(env) ||
    Object.keys(env).some((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR')
  ) {
    throw new Error('External Claude settings cannot override the pinned configuration home.')
  }
}

function assertArguments(agent: string, args: string[], managed: boolean): void {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (agent === 'claude' && /^--(settings|setting-sources)(=|$)/.test(argument)) {
      if (managed || argument.startsWith('--setting-sources')) {
        throw new Error('Profile commands cannot select unvalidated authentication settings.')
      }
      assertExternalClaudeSettings(
        argument === '--settings' ? args[++index] : argument.slice('--settings='.length)
      )
    }
    if (agent !== 'codex') {
      continue
    }
    if (
      managed &&
      (/^(--oss|--local-provider|--remote|--cd|-C)(=|$)/.test(argument) || /^-C./.test(argument))
    ) {
      throw new Error('Profile commands cannot redirect the Codex provider.')
    }
    if ((argument === '-c' || argument === '--config') && !args[index + 1]) {
      throw new Error('Codex configuration overrides require a value.')
    }
    if (managed && (/^(--profile|-p)(=|$)/.test(argument) || /^-p./.test(argument))) {
      throw new Error('Profile commands cannot select another Codex configuration profile.')
    }
    const config =
      argument === '-c' || argument === '--config'
        ? args[++index]
        : argument.startsWith('--config=')
          ? argument.slice(9)
          : argument.startsWith('-c')
            ? argument.slice(2)
            : undefined
    if (
      managed &&
      config !== undefined &&
      !/^(model|model_reasoning_effort|approval_policy|sandbox_mode|features\.no_daemon)=/.test(
        config
      )
    ) {
      throw new Error('Profile commands cannot override authentication configuration.')
    }
  }
}

export function assertAgentProfileEnvironment(
  prepared: PreparedAgentProfile,
  env: Record<string, string> = {}
): void {
  const homeVariable = prepared.snapshot.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
  const forbidden = new Set([
    homeVariable,
    ...prepared.envToDelete,
    ...Object.keys(prepared.envPatch)
  ])
  for (const key of Object.keys(env)) {
    if (forbidden.has(key.toUpperCase())) {
      throw new Error(`Remove the ${key} override before launching this profile.`)
    }
  }
}

export function pinAgentProfileTerminalCommand(
  prepared: PreparedAgentProfile,
  command: string | undefined,
  env?: Record<string, string>
): string {
  assertAgentProfileEnvironment(prepared, env)
  const parsed = tokenizeStartupCommand(command ?? '', 'posix')
  const { executable, agent } = prepared.snapshot
  if (
    !isAbsolute(executable) ||
    !parsed.ok ||
    !parsed.tokens.length ||
    parsed.spans.some((span) => span.divergesFromShell) ||
    /[\r\n\0]/.test(command ?? '')
  ) {
    throw new Error('Profiles require a direct agent command; shell wrappers are not supported.')
  }
  const [first, ...args] = parsed.tokens
  if (first !== agent && first !== executable && first !== prepared.priorExecutable) {
    throw new Error('Profile command does not match its detected executable.')
  }
  assertArguments(agent, args, prepared.snapshot.binding.kind === 'managed')
  // The real terminal and its authority probe must select the same credential backend.
  const authorityArgs =
    agent === 'codex' && prepared.snapshot.binding.kind === 'managed'
      ? CODEX_PROFILE_FILE_AUTH_ARGS
      : []
  return [executable, ...authorityArgs, ...args]
    .map((arg) => quoteStartupArg(arg, 'posix'))
    .join(' ')
}

/** Accepts only a host-generated command already validated by the pinning phase. */
export function bindAgentProfileTerminalEnvironment(
  prepared: PreparedAgentProfile,
  pinnedCommand: string
): string {
  const names = [...prepared.envToDelete, ...Object.keys(prepared.envPatch)]
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error('Invalid profile environment variable.')
  }
  const deletions = prepared.envToDelete.flatMap((name) => ['-u', name])
  const assignments = Object.entries(prepared.envPatch).map(([key, value]) => `${key}=${value}`)
  const prefix = ['/usr/bin/env', ...deletions, ...assignments]
    .map((arg) => quoteStartupArg(arg, 'posix'))
    .join(' ')
  return `${prefix} ${pinnedCommand}`
}

export function prepareAgentProfileTerminalCommand(
  prepared: PreparedAgentProfile,
  command: string | undefined,
  env?: Record<string, string>
): { command: string; launchAgent: 'claude' | 'codex' } {
  return {
    command: bindAgentProfileTerminalEnvironment(
      prepared,
      pinAgentProfileTerminalCommand(prepared, command, env)
    ),
    launchAgent: prepared.snapshot.agent
  }
}
