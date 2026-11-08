import { checkAcpLaunchVersion } from './acp-launch-version'

import {
  assertStructuredAgentResolutionCurrent,
  resolveAgainAfterRefreshOnMissingProgram,
  type StructuredAgentCommand,
  type StructuredAgentCommandSettings,
  type StructuredAgentResolutionOperation
} from '../../native-chat/structured-agent-command-resolution'
// Launch from durable record values for the working directory, pinned account and resume session.

import {
  resolveAntigravityChatAuthConfig,
  type AntigravityChatAuthConfig
} from '../../../shared/antigravity-chat-auth-config'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { assertAntigravityChatAuthPublished } from '../../antigravity/antigravity-chat-auth-publication'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import type { resolveCliCommand } from '../../../shared/node-cli-command-resolution'
import type { AgentCliVersionReader } from '../../agent-launch/preflight/agent-cli-version-probe'
import { AgentCliInstallationError } from '../../native-chat/agent-cli-installation-error'
import type { JournalLoad } from '../../native-chat/agent-session-journal/replay/journal-open'
import type { StructuredAgentLaunchPartResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../../runtime/agent-session/environment/structured-session-child-env'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  withNativeChatVisualsEnv
} from '../../native-chat/native-chat-visuals-delivery'
import type { AcpLaunchSpec } from './acp-launch-contract'
import { acpLaunchSpecForAccount, resolveAcpLaunchCommand } from './acp-launch-command'
import { nothingExchangedOn } from '../session/acp-structured-resume-history'
import { acpUnannouncedLosses } from '../session/start/acp-session-reopen-failure'
import { loadAcpVisualsSkill, type AcpLaunchVisualsDeps } from './acp-structured-launch-visuals'

export type AcpStructuredLaunch = StructuredAgentCommand & {
  spec: AcpLaunchSpec
  antigravityChatAuth?: AntigravityChatAuthConfig
  args: string[]
  cwd: string
  /** Sealed for spawns; recovery reads use the unsealed agent environment. */
  env: Record<string, string>
  envToDelete: string[]
  fullAccess: boolean
  /** The saved model the launch line carries. */
  launchModel?: string
  resume: {
    sessionId: string
    key: string
    /** A chat-created session with no exchanged turn may never have been saved. */
    mayBeUnsaved: () => boolean
    /** Lost conversations whose warning rows are missing; read after startup succeeds. */
    unannouncedLosses: () => string[]
  } | null
}

export type AcpStructuredLaunchPartDeps = {
  /** Reads without opening the journal. */
  readJournal: (sessionId: string) => JournalLoad | null
  resolveCommand?: typeof resolveCliCommand
  homePath?: string
  inheritedEnv?: NodeJS.ProcessEnv
  probeVersion?: AgentCliVersionReader
  dataDirectory: string
} & Pick<AcpLaunchVisualsDeps, 'logger'>

export type AcpLaunchSettings = StructuredAgentCommandSettings &
  Partial<Pick<GlobalSettings, 'antigravityChatAuth'>>

export type AcpLaunchInvocationDeps = {
  operation?: StructuredAgentResolutionOperation
  /** Reread per acquisition. */
  resolveEnvironment: () => Promise<Record<string, string>>
  resolveLaunchEnv?: (agent: string) => Record<string, string>
  /** Reread per acquisition; absent uses the stock command. */
  resolveCommandSettings?: () => AcpLaunchSettings
  /** Optional environment refresh after a missing-program lookup. */
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  /** Resolves relative PATH entries against the launch directory. */
  resolveWorkingDirectory?: () => Promise<string> | string
} & Pick<
  AcpStructuredLaunchPartDeps,
  'resolveCommand' | 'homePath' | 'inheritedEnv' | 'dataDirectory'
>

/** What a launch runs, and the spec of the backend the account home pins. */
export type AcpLaunchInvocation = StructuredAgentCommand & {
  env: Record<string, string>
  envToDelete: string[]
  spec: AcpLaunchSpec
  antigravityChatAuth?: AntigravityChatAuthConfig
}

/** Resolve chats and probes consistently; optionally refresh once after a missing-program lookup. */
export function resolveAcpLaunchInvocation(
  spec: AcpLaunchSpec,
  accountHome: AgentSessionAccountHome,
  deps: AcpLaunchInvocationDeps
): Promise<AcpLaunchInvocation> {
  return resolveAgainAfterRefreshOnMissingProgram(
    () => readAcpLaunchInvocation(spec, accountHome, deps),
    deps.refreshEnvironmentAfterMiss,
    { env: ({ env }) => env, cwd: deps.resolveWorkingDirectory },
    deps.operation
  )
}

async function readAcpLaunchInvocation(
  agentSpec: AcpLaunchSpec,
  accountHome: AgentSessionAccountHome,
  deps: AcpLaunchInvocationDeps
): Promise<AcpLaunchInvocation> {
  const spec = acpLaunchSpecForAccount(agentSpec, accountHome)
  assertStructuredAgentResolutionCurrent(deps.operation)
  const base = await deps.resolveEnvironment()
  assertStructuredAgentResolutionCurrent(deps.operation)
  const env: Record<string, string> = spec.account.environment(accountHome, {
    ...base,
    ...deps.resolveLaunchEnv?.(spec.agent)
  })
  const envToDelete = spec.scrubEnvironment?.(env, deps.inheritedEnv ?? process.env) ?? []
  Object.assign(env, spec.env)
  const commandSettings = deps.resolveCommandSettings?.()
  // Orca's account-type setting selects only the managed server's sign-in.
  const usesChatAuth = spec.agent === 'antigravity' && spec.authMethod !== undefined
  if (usesChatAuth) {
    assertAntigravityChatAuthPublished(commandSettings?.antigravityChatAuth)
  }
  const antigravityChatAuth = usesChatAuth
    ? resolveAntigravityChatAuthConfig(commandSettings?.antigravityChatAuth)
    : undefined
  const invocation = resolveAcpLaunchCommand(spec, env, { ...deps, commandSettings })
  return {
    ...invocation,
    env,
    envToDelete,
    spec,
    ...(antigravityChatAuth ? { antigravityChatAuth } : {})
  }
}

export function acpStructuredLaunchPart(
  agentSpec: AcpLaunchSpec,
  deps: AcpStructuredLaunchPartDeps
): StructuredAgentLaunchPartResolver<AcpStructuredLaunch> {
  return async (basis, identity) => {
    const { record } = basis
    const { env, envToDelete, command, prefixArgs, spec, antigravityChatAuth } =
      await resolveAcpLaunchInvocation(agentSpec, record.accountHome, {
        resolveEnvironment: basis.baseEnvironment,
        resolveLaunchEnv: () => basis.launchEnv(),
        resolveCommandSettings: basis.commandSettings,
        refreshEnvironmentAfterMiss: basis.refreshAfterMissingProgram,
        resolveWorkingDirectory: basis.launchDirectory,
        ...(deps.resolveCommand ? { resolveCommand: deps.resolveCommand } : {}),
        ...(deps.homePath ? { homePath: deps.homePath } : {}),
        ...(deps.inheritedEnv ? { inheritedEnv: deps.inheritedEnv } : {}),
        dataDirectory: deps.dataDirectory
      })
    const cwd = await basis.launchDirectory()
    const visuals = spec.visualsSkill ? await basis.visuals() : null
    // PATH may have changed since chat creation.
    const launchVersion = await checkAcpLaunchVersion(
      spec,
      { command, prefixArgs, cwd, env },
      visuals !== null,
      deps.probeVersion
    )
    if (launchVersion.status === 'tooOld') {
      throw AgentCliInstallationError.tooOld(spec.agent, launchVersion)
    }
    const skill = visuals
      ? await loadAcpVisualsSkill(spec, deps, {
          sessionId: identity.sessionId,
          visuals,
          version: launchVersion.version,
          env,
          envToDelete,
          inherited: deps.inheritedEnv ?? process.env
        })
      : null
    const fullAccess = basis.permissionMode === 'full-access'
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    // A load restores the conversation's own model, and a stale role there would stop the agent
    // before it opens; resumed chats apply their model through the session instead.
    const model = spec.launchesWithModel && !head ? record.options?.model : undefined
    const args = spec.args({ fullAccess, pluginDir: skill?.pluginDir ?? null, model })
    return {
      launch: {
        spec,
        ...(antigravityChatAuth ? { antigravityChatAuth } : {}),
        command,
        prefixArgs,
        args: [...prefixArgs, ...args],
        fullAccess,
        ...(model ? { launchModel: model } : {}),
        resume: head
          ? {
              sessionId: head.handle.nativeId,
              key: agentSessionProviderHandleKey(head.handle),
              mayBeUnsaved: () =>
                head.origin === 'created' &&
                nothingExchangedOn(deps.readJournal, identity.sessionId, head.handle.nativeId),
              unannouncedLosses: () =>
                acpUnannouncedLosses(
                  deps.readJournal,
                  identity.sessionId,
                  record.providerHandleChain
                )
            }
          : null
      },
      env: withNativeChatVisualsEnv({ ...env, ...skill?.env }, skill ? visuals : null),
      inheritedEnvToDelete: [
        ...STRUCTURED_CHILD_ENV_TO_DELETE,
        ...envToDelete,
        // An inherited scratch directory belongs to a different chat.
        ...(skill ? [] : [NATIVE_CHAT_SCRATCH_DIR_ENV]),
        LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
      ]
    }
  }
}
