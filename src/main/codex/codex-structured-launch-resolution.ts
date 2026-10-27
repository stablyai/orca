import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { resolveCodexCommand } from '../codex-cli/command'
import { resolveAgainAfterRefreshOnMissingProgram } from '../native-chat/structured-agent-command-resolution'
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
  resolveCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
}

export type CodexStructuredInvocationDeps = Pick<
  CodexStructuredLaunchPartDeps,
  'resolveCommand'
> & {
  /** Fresh spawn environment, never persisted in the session record. */
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** Refresh after a missing binary; absence disables retry. */
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  /** Resolve relative PATH entries from the spawn directory; defaults to Orca's cwd. */
  resolveWorkingDirectory?: () => Promise<string> | string
}

export type CodexStructuredInvocation = {
  command: string
  environment: NodeJS.ProcessEnv | undefined
}

/** Keep session launches and catalog probes on the same binary/environment resolution path. */
export function resolveCodexStructuredInvocation(
  deps: CodexStructuredInvocationDeps
): Promise<CodexStructuredInvocation> {
  return resolveAgainAfterRefreshOnMissingProgram(
    () => readCodexStructuredInvocation(deps),
    deps.refreshEnvironmentAfterMiss,
    { env: ({ environment }) => environment, cwd: deps.resolveWorkingDirectory }
  )
}

async function readCodexStructuredInvocation(
  deps: CodexStructuredInvocationDeps
): Promise<CodexStructuredInvocation> {
  const environment = await deps.resolveEnvironment?.()
  const pathEnv = environment?.PATH ?? environment?.Path ?? null
  const homePath = environment?.HOME ?? environment?.USERPROFILE
  const command = (deps.resolveCommand ?? resolveCodexCommand)({
    pathEnv,
    ...(homePath ? { homePath } : {})
  })
  return { command, environment }
}

/** Derive resume identity and account home from the durable record. */
export function codexStructuredLaunchPart(
  deps: CodexStructuredLaunchPartDeps
): StructuredAgentLaunchPartResolver<CodexStructuredLaunch> {
  return async (basis) => {
    const { record } = basis
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const { command } = await resolveCodexStructuredInvocation({
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
        args: [...args, 'app-server'],
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
