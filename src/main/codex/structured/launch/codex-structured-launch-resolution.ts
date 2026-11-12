import { readCodexExecutionExecutable } from './codex-execution-executable'
import { pathEnvRelativeTo } from '../../../../shared/node-cli-command-resolution'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
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
} from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { moveCodexThreadIntoAccountHome } from '../../history/resume/codex-thread-account-move'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { resolveCodexCommand } from '../../../codex-cli/command'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'
import type { StructuredAgentLaunchPartResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition'
import type { CodexStructuredLaunch } from '../session-lifecycle/codex-structured-session-state'
import { codexStructuredPermissionPolicy } from '../../../../shared/codex-permission-policy'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import { codexOrcaHooksOffArgs } from './codex-structured-orca-hooks-off'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { codexExecutionLaunch } from './codex-execution-controls'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  withNativeChatVisualsEnv
} from '../../../native-chat/conversation-files/native-chat-visuals-delivery'

export type CodexStructuredLaunchPartDeps = {
  resolveLaunchArgs: () => Promise<string[]> | string[]
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
    const execution = codexExecutionLaunch(record)
    const recordHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const { command, prefixArgs } = await resolveCodexStructuredInvocation({
      ...(deps.resolveCommand ? { resolveCommand: deps.resolveCommand } : {}),
      refreshEnvironmentAfterMiss: basis.refreshAfterMissingProgram,
      resolveWorkingDirectory: basis.launchDirectory,
      resolveEnvironment: basis.environment
    })
    const environment = await basis.environment()
    const args = execution?.args ?? codexStructuredLaunchArgs(await deps.resolveLaunchArgs())
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    const resumeThreadId = head?.handle.nativeId ?? null
    // Match the first turn's model to avoid duplicate prompt injection on a model switch.
    const model = record.options?.model
    const visuals = execution ? null : await basis.visuals()
    const launchDirectory = await basis.launchDirectory()
    const executable = execution
      ? await readCodexExecutionExecutable(command, prefixArgs, launchDirectory, environment)
      : undefined
    const selectedHome = execution
      ? undefined
      : await deps.prepareLaunchAccountHome?.(record, launchDirectory)
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
    return {
      launch: {
        command,
        prefixArgs,
        // Before the user's args: a later -c table replaces this one, so their hooks.state wins.
        args: [
          ...prefixArgs,
          ...(execution
            ? []
            : codexOrcaHooksOffArgs(
                accountHome.path || environment?.CODEX_HOME || getSystemCodexHomePath()
              )),
          ...args,
          'app-server'
        ],
        codexHome: accountHome.path,
        resumeThreadId,
        ...(execution
          ? {
              execution: {
                policy: execution.policy,
                profileId: execution.profileId,
                ...(executable ? { executable } : {})
              }
            }
          : {}),
        // Only created threads may be unsaved; resumed, forked and adopted threads were persisted.
        ...(resumeThreadId && head?.origin === 'created' ? { supersedeIfUnsaved: true } : {}),
        // Own settings leaves a new thread to config and a resumed thread to its saved policy.
        ...(execution || basis.permissionMode === 'own'
          ? {}
          : { permissionPolicy: codexStructuredPermissionPolicy(basis.permissionMode ?? 'ask') }),
        ...(model ? { model } : {}),
        ...(visuals ? { visuals } : {})
      },
      env: withNativeChatVisualsEnv(
        { ...environment, ...(accountHome.path ? { CODEX_HOME: accountHome.path } : {}) },
        visuals
      ),
      // Clear inherited scratch paths that may belong to another chat.
      inheritedEnvToDelete: [
        ...(execution
          ? ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL']
          : []),
        ...(visuals ? [] : [NATIVE_CHAT_SCRATCH_DIR_ENV]),
        LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
      ],
      cliRuntimeCommand: command
    }
  }
}
