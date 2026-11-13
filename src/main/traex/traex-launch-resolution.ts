import { homedir } from 'node:os'
import { join } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentChatPermissionChoice } from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { checkAgentCliVersion } from '../agent-launch/preflight/agent-cli-version-probe'
import { AgentCliInstallationError } from '../native-chat/agent-cli-installation-error'
import { StructuredAgentArgumentsError } from '../native-chat/structured-agent-arguments-error'
import {
  resolveAgainAfterRefreshOnMissingProgram,
  resolveStructuredAgentCommand,
  type StructuredAgentCommandSettings,
  type StructuredAgentResolutionOperation
} from '../native-chat/structured-agent-command-resolution'
import type { StructuredAgentLaunchPartResolver } from '../runtime/agent-session/launch/structured-agent-launch-composition'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/agent-session/environment/structured-session-child-env'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { StructuredAgentModelCatalogContext } from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import type { AgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import type { JournalLoad } from '../native-chat/agent-session-journal/replay/journal-open'
import { providerConversationHasNoTurns } from '../native-chat/agent-session-timeline/provider-timeline-unused-conversation'

export const TRAEX_MINIMUM_VERSIONS = ['0.214.1'] as const
export const TRAEX_INHERITED_ENV_TO_DELETE = [
  ...STRUCTURED_CHILD_ENV_TO_DELETE,
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'TRAECLI_THREAD_ID'
] as const

export type TraexLaunch = ProviderProcessLaunch & {
  cwd: string
  previousThreadId: string | null
  mayBeUnsaved: boolean
  options: Readonly<Record<string, string>>
  permissionMode: AgentChatPermissionChoice
  commandEnv?: Record<string, string>
}

export function traexPrivateHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  return env.TRAECLI_HOME?.trim() || join(env.TRAE_HOME?.trim() || join(home, '.trae'), 'cli')
}

export function resolveTraexCommand(
  env: NodeJS.ProcessEnv,
  settings: StructuredAgentCommandSettings = {}
) {
  const homePath = env.HOME ?? env.USERPROFILE
  return resolveStructuredAgentCommand(
    'trae',
    settings,
    {
      pathEnv: env.PATH ?? env.Path ?? null,
      ...(homePath ? { homePath } : {})
    },
    { command: 'traecli' }
  )
}

export function resolveTraexInvocation(input: {
  accountPath: string
  environment: () => Promise<Record<string, string>>
  settings: () => StructuredAgentCommandSettings
  refresh?: (askedAt: number) => Promise<void>
  cwd: string
  operation?: StructuredAgentResolutionOperation
}) {
  return resolveAgainAfterRefreshOnMissingProgram(
    async () => {
      const env = { ...(await input.environment()), TRAECLI_HOME: input.accountPath }
      return { ...resolveTraexCommand(env, input.settings()), env }
    },
    input.refresh,
    { env: ({ env }) => env, cwd: () => input.cwd, signal: input.operation?.signal },
    input.operation
  )
}

export async function resolveTraexReadLaunch(
  context: StructuredAgentModelCatalogContext,
  accountHome: AgentSessionAccountHome,
  cwd: string,
  operation?: StructuredAgentResolutionOperation
): Promise<ProviderProcessLaunch> {
  const invocation = await resolveTraexInvocation({
    accountPath: requireLegacyAgentSessionAccountHome(accountHome).path,
    cwd,
    environment: () => context.environment.resolveAgentEnvironment('trae'),
    settings: () => context.deps.resolveAgentCommandSettings?.() ?? {},
    refresh: context.environment.refreshAfterMissingProgram,
    operation
  })
  const args = traexAppServerArgs(await context.deps.resolveLaunchArgs('trae'))
  return {
    ...invocation,
    cwd,
    args: [...invocation.prefixArgs, ...args],
    envToDelete: TRAEX_INHERITED_ENV_TO_DELETE
  }
}

const VALUE_CONFIG_OPTIONS = new Set(['-c', '--config', '--enable', '--disable'])
const MODEL_OPTIONS = new Set(['-m', '--model'])
const IGNORED_VALUE_OPTIONS = new Set([
  '-m',
  '--model',
  '-a',
  '--ask-for-approval',
  '-s',
  '--sandbox',
  '--permission-mode',
  '-C',
  '--cd',
  '--add-dir',
  '-i',
  '--image'
])
const IGNORED_SWITCHES = new Set([
  '--yolo',
  '-y',
  '--dangerously-bypass-approvals-and-sandbox',
  '--no-alt-screen',
  '--no-daemon',
  '--dangerously-bypass-hook-trust'
])

export function traexAppServerArgs(tokens: readonly string[]): string[] {
  const args: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    const equal = token.indexOf('=')
    const option = equal === -1 ? token : token.slice(0, equal)
    if (IGNORED_SWITCHES.has(option)) {
      continue
    }
    if (VALUE_CONFIG_OPTIONS.has(option) || IGNORED_VALUE_OPTIONS.has(option)) {
      const value = equal === -1 ? tokens[++index] : token.slice(equal + 1)
      if (!value || value.startsWith('-')) {
        throw new StructuredAgentArgumentsError('TRAE CLI', option, 'missingValue')
      }
      if (MODEL_OPTIONS.has(option)) {
        args.push('-c', `model=${JSON.stringify(value)}`)
      } else if (VALUE_CONFIG_OPTIONS.has(option)) {
        args.push(option, value)
      }
      continue
    }
    throw new StructuredAgentArgumentsError(
      'TRAE CLI',
      token,
      token.startsWith('-') ? 'unsupportedOption' : 'positionalPrompt'
    )
  }
  return [...args, 'app-server', '--stdio']
}

export function traexPermissionSettings(mode: AgentChatPermissionChoice): Record<string, unknown> {
  if (mode === 'own') {
    return {}
  }
  return {
    approvalPolicy: mode === 'full-access' ? 'never' : 'on-request',
    approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
    sandbox:
      mode === 'full-access'
        ? 'danger-full-access'
        : mode === 'auto'
          ? 'workspace-write'
          : 'read-only'
  }
}

export function traexLaunchPart(deps: {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  readJournal: (sessionId: string) => JournalLoad | null
}): StructuredAgentLaunchPartResolver<TraexLaunch> {
  return async (basis) => {
    const account = requireLegacyAgentSessionAccountHome(basis.record.accountHome)
    const cwd = await basis.launchDirectory()
    const invocation = await resolveTraexInvocation({
      accountPath: account.path,
      cwd,
      environment: basis.environment,
      settings: basis.commandSettings,
      refresh: basis.refreshAfterMissingProgram
    })
    const version = await checkAgentCliVersion(
      { program: invocation.command, prefixArgs: invocation.prefixArgs, cwd, env: invocation.env },
      TRAEX_MINIMUM_VERSIONS
    )
    if (version.status === 'tooOld') {
      throw AgentCliInstallationError.tooOld('trae', version)
    }
    const previous = agentSessionProviderHandleChainHead(basis.record.providerHandleChain)
    return {
      launch: {
        command: invocation.command,
        args: [...invocation.prefixArgs, ...traexAppServerArgs(await deps.resolveLaunchArgs())],
        previousThreadId: previous?.handle.nativeId ?? null,
        mayBeUnsaved:
          previous?.origin === 'created' &&
          providerConversationHasNoTurns(
            deps.readJournal,
            basis.record.sessionId,
            previous.handle.nativeId
          ),
        options: basis.record.options ?? {},
        permissionMode: basis.permissionMode ?? 'ask'
      },
      env: invocation.env,
      inheritedEnvToDelete: TRAEX_INHERITED_ENV_TO_DELETE,
      cliRuntimeCommand: invocation.command
    }
  }
}
