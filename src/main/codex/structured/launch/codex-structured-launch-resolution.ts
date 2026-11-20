import { codexBotToolsThreadConfig } from '../../../bots/bot-tools-codex'
import { withBotLaunchToolsEnv } from '../../../bots/bot-launch-tools'
import { pathEnvRelativeTo } from '../../../../shared/shell/command-resolution/node-cli-command-resolution'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import {
  assertStructuredAgentResolutionCurrent,
  resolveAgainAfterRefreshOnMissingProgram,
  type StructuredAgentCommand,
  type StructuredAgentResolutionOperation
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
// How a durable session record becomes a Codex process launch.
//
// Every input except the account is read back from the record the store already made durable,
// not from the call that triggered spawn. A client that attaches twice must land in the same
// working directory, and a resume must name the thread this session actually proved — never one
// a caller asks for, which is how a resume becomes a fork wearing a resume's name. The account
// follows the selection, as Claude chats do.

import {
  agentSessionAccountHome,
  agentSessionAccountHomesEqual,
  requireLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { moveCodexThreadIntoAccountHome } from '../../history/resume/codex-thread-account-move'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { resolveCodexCommand } from '../../../codex-cli/command'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'
import type { StructuredAgentLaunchPartResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition'
import type { CodexStructuredLaunch } from '../session-lifecycle/codex-structured-session-state'
import { codexStructuredPermissionPolicy } from '../../../../shared/agent-launch/permissions/codex-permission-policy'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import { codexReadOnlyThreadConfig } from '../prompts/codex-structured-read-only'
import { codexOrcaHooksOffArgs } from './codex-structured-orca-hooks-off'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  withNativeChatVisualsEnv
} from '../../../native-chat/conversation-files/native-chat-visuals-delivery'
import { linkedSkillsSection } from '../../../native-chat/native-chat-skill-roots'
import {
  nothingExchangedOn,
  type SavedProviderTurnReads
} from '../../../native-chat/agent-session-journal/journal-provider-turn-saved'

export type CodexStructuredLaunchPartDeps = {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  savedSession: SavedProviderTurnReads
  /** The selected account's home, prepared for this start in `launchDirectory`; null keeps the record's. */
  prepareLaunchAccountHome?: (
    record: AgentSessionRecord,
    launchDirectory: string
  ) => Promise<AgentSessionAccountHome | null>
  resolveCommand?: (options?: {
    pathEnv?: string | null
    homePath?: string
  }) => StructuredAgentCommand
}

export type CodexStructuredInvocationDeps = Pick<
  CodexStructuredLaunchPartDeps,
  'resolveCommand'
> & {
  signal?: AbortSignal
  operation?: StructuredAgentResolutionOperation
  /** Fresh spawn environment, never persisted in the session record. */
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** Refresh after a missing binary; absence disables retry. */
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  /** Resolve relative PATH entries from the spawn directory; defaults to Orca's cwd. */
  resolveWorkingDirectory?: () => Promise<string> | string
}

export type CodexStructuredInvocation = {
  command: string
  prefixArgs: string[]
  /** The user's Command setting; absent for the stock CLI. */
  configured?: string
  environment: NodeJS.ProcessEnv | undefined
}

/** Keep session launches and catalog probes on the same binary/environment resolution path. */
export function resolveCodexStructuredInvocation(
  deps: CodexStructuredInvocationDeps
): Promise<CodexStructuredInvocation> {
  return resolveAgainAfterRefreshOnMissingProgram(
    () => readCodexStructuredInvocation(deps),
    deps.refreshEnvironmentAfterMiss,
    {
      env: ({ environment }) => environment,
      cwd: deps.resolveWorkingDirectory,
      signal: deps.signal
    },
    deps.operation
  )
}

async function readCodexStructuredInvocation(
  deps: CodexStructuredInvocationDeps
): Promise<CodexStructuredInvocation> {
  assertStructuredAgentResolutionCurrent(deps.operation)
  const environment = await waitForPromiseWithSignal(
    Promise.resolve(deps.resolveEnvironment?.()),
    deps.signal
  )
  assertStructuredAgentResolutionCurrent(deps.operation)
  const cwd = await waitForPromiseWithSignal(
    Promise.resolve(deps.resolveWorkingDirectory?.()),
    deps.signal
  )
  assertStructuredAgentResolutionCurrent(deps.operation)
  deps.signal?.throwIfAborted()
  const pathEnv = pathEnvRelativeTo(environment?.PATH ?? environment?.Path, cwd ?? process.cwd())
  const homePath = environment?.HOME ?? environment?.USERPROFILE
  const options = {
    pathEnv,
    ...(homePath ? { homePath } : {})
  }
  const invocation = deps.resolveCommand
    ? deps.resolveCommand(options)
    : { command: resolveCodexCommand(options), prefixArgs: [] }
  return { ...invocation, environment }
}

/** The host compares this with the selection to move an idle chat to a newly picked account. */
export function codexLaunchedAccountHome(launch: Pick<CodexStructuredLaunch, 'codexHome'>): {
  accountHome?: AgentSessionAccountHome
} {
  return launch.codexHome
    ? { accountHome: agentSessionAccountHome(CODEX_STRUCTURED_AGENT, launch.codexHome) }
    : {}
}

/** Derive resume identity from the durable record and the account from the selection. */
export function codexStructuredLaunchPart(
  deps: CodexStructuredLaunchPartDeps
): StructuredAgentLaunchPartResolver<CodexStructuredLaunch> {
  return async (basis) => {
    const { record } = basis
    const recordHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const { command, prefixArgs, configured } = await resolveCodexStructuredInvocation({
      ...(deps.resolveCommand ? { resolveCommand: deps.resolveCommand } : {}),
      refreshEnvironmentAfterMiss: basis.refreshAfterMissingProgram,
      resolveWorkingDirectory: basis.launchDirectory,
      resolveEnvironment: basis.environment
    })
    const environment = await basis.environment()
    const args = codexStructuredLaunchArgs(await deps.resolveLaunchArgs())
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    const resumeThreadId = head?.handle.nativeId ?? null
    // Match the first turn's model to avoid duplicate prompt injection on a model switch.
    const model = record.options?.model
    const visuals = await basis.visuals()
    const launchDirectory = await basis.launchDirectory()
    const selectedHome = await deps.prepareLaunchAccountHome?.(record, launchDirectory)
    const accountHome = selectedHome
      ? requireLegacyAgentSessionAccountHome(selectedHome)
      : recordHome
    if (
      resumeThreadId &&
      selectedHome &&
      !agentSessionAccountHomesEqual(selectedHome, record.accountHome)
    ) {
      await moveCodexThreadIntoAccountHome({
        threadId: resumeThreadId,
        fromHome: recordHome.path,
        toHome: accountHome.path
      })
    }
    const linkedSkills = await basis.linkedSkills()
    const developerInstructions = await basis.instructions(
      linkedSkillsSection(linkedSkills.projects, [])
    )
    const tools = await basis.toolServers()
    const threadConfig = basis.readOnly
      ? codexReadOnlyThreadConfig(basis.readOnly)
      : tools.servers.length > 0
        ? codexBotToolsThreadConfig(tools)
        : null
    // Codex saves a thread at its first turn; one that exchanged a turn lost its history, not nothing.
    // Turns written since this thread's creation fence ran on it, even before Codex echoed the send.
    const supersedeIfUnsaved =
      resumeThreadId !== null &&
      head?.origin === 'created' &&
      (await nothingExchangedOn(
        deps.savedSession,
        record.sessionId,
        resumeThreadId,
        head.mintedAtFence
      ))
    return {
      launch: {
        command,
        prefixArgs,
        // A custom command may be a wrapper that depends on its folder; it never shares a server.
        ...(configured ? { customCommand: true } : {}),
        // Before the user's args: a later -c table replaces this one, so their hooks.state wins.
        args: [
          ...prefixArgs,
          ...codexOrcaHooksOffArgs(
            accountHome.path || environment?.CODEX_HOME || getSystemCodexHomePath()
          ),
          ...args,
          'app-server'
        ],
        codexHome: accountHome.path,
        resumeThreadId,
        ...(supersedeIfUnsaved ? { supersedeIfUnsaved } : {}),
        // Own settings leaves a new thread to config and a resumed thread to its saved policy.
        ...(basis.permissionMode === 'own'
          ? {}
          : { permissionPolicy: codexStructuredPermissionPolicy(basis.permissionMode ?? 'ask') }),
        ...(model ? { model } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
        ...(visuals ? { visuals } : {}),
        // Refused even empty: a project linked later must then reach it as a list with paths.
        ...(linkedSkills.root
          ? {
              linkedSkillsRoot: linkedSkills.root.skillsRoot,
              linkedSkillsRefused: () =>
                basis.linkedSkillsRefused(
                  linkedSkillsSection(linkedSkills.projects, linkedSkills.projects)
                )
            }
          : {}),
        ...(threadConfig ? { threadConfig } : {}),
        ...(basis.readOnly && threadConfig ? { readOnly: basis.readOnly } : {})
      },
      env: withNativeChatVisualsEnv(
        withBotLaunchToolsEnv(
          { ...environment, ...(accountHome.path ? { CODEX_HOME: accountHome.path } : {}) },
          tools
        ),
        visuals
      ),
      commandEnv: tools.commandEnv,
      // Clear inherited scratch paths that may belong to another chat.
      inheritedEnvToDelete: [
        ...(visuals ? [] : [NATIVE_CHAT_SCRATCH_DIR_ENV]),
        LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
      ],
      cliRuntimeCommand: command
    }
  }
}
