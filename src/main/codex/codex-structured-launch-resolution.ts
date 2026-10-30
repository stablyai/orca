import { delimiter, isAbsolute, resolve } from 'node:path'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  assertStructuredAgentResolutionCurrent,
  resolveAgainAfterRefreshOnMissingProgram,
  type StructuredAgentCommand,
  type StructuredAgentResolutionOperation
} from '../native-chat/structured-agent-command-resolution'
// How a durable session record becomes a Codex process launch.
//
// Every input is read back from the record the store already made durable, not
// from the call that triggered spawn. A client that attaches twice must
// land in the same working directory under the same account home, and a resume
// must name the thread this session actually proved — never one a caller asks
// for, which is how a resume becomes a fork wearing a resume's name.

import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { resolveCodexCommand } from '../codex-cli/command'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'
import type { CodexStructuredLaunch } from './codex-structured-session-adapter'
import { codexStructuredPermissionPolicy } from '../../shared/codex-permission-policy'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  withNativeChatVisualsEnv
} from '../native-chat/native-chat-visuals-delivery'

export type CodexStructuredLaunchPartDeps = {
  resolveLaunchArgs: () => Promise<string[]> | string[]
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
  const pathEnv =
    (environment?.PATH ?? environment?.Path)
      ?.split(delimiter)
      .map((entry) => (entry && !isAbsolute(entry) ? resolve(cwd ?? process.cwd(), entry) : entry))
      .join(delimiter) ?? null
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

/** Derive resume identity and account home from the durable record. */
export function codexStructuredLaunchPart(
  deps: CodexStructuredLaunchPartDeps
): StructuredAgentLaunchPartResolver<CodexStructuredLaunch> {
  return async (basis) => {
    const { record } = basis
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const { command, prefixArgs } = await resolveCodexStructuredInvocation({
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
    await basis.launchDirectory()
    return {
      launch: {
        command,
        prefixArgs,
        args: [...prefixArgs, ...args, 'app-server'],
        codexHome: accountHome.path,
        resumeThreadId,
        // Only created threads may be unsaved; resumed, forked and adopted threads were persisted.
        ...(resumeThreadId && head?.origin === 'created' ? { supersedeIfUnsaved: true } : {}),
        // Own settings leaves a new thread to config and a resumed thread to its saved policy.
        ...(basis.permissionMode === 'own'
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
        ...(visuals ? [] : [NATIVE_CHAT_SCRATCH_DIR_ENV]),
        LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
      ],
      cliRuntimeCommand: command
    }
  }
}
