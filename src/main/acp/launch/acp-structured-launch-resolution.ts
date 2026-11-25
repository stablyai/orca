import {
  antigravityChatAuthEnvironment,
  launchAntigravityChatAuth
} from '../../antigravity/antigravity-chat-auth-environment'
import { checkAcpLaunchVersion } from './acp-launch-version'
import type { McpServer } from '../generated/acp-protocol.generated'
import { botToolsOffInstruction, withBotLaunchToolsEnv } from '../../bots/bot-launch-tools'
import { acpBotMcpServers } from '../../bots/bot-tools-acp'
import { overlayEnvironmentVariables } from '../../../shared/shell/launch/environment-overlay'

import {
  assertStructuredAgentResolutionCurrent,
  resolveAgainAfterRefreshOnMissingProgram,
  type StructuredAgentCommand,
  type StructuredAgentCommandSettings,
  type StructuredAgentResolutionOperation
} from '../../native-chat/agent-launch/structured-agent-command-resolution'
// Launch from durable record values for the working directory, pinned account and resume session.

import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { resolveCliCommand } from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import type { AgentCliVersionReader } from '../../agent-launch/preflight/agent-cli-version-probe'
import { AgentCliInstallationError } from '../../native-chat/agent-launch/agent-cli-installation-error'
import type { StructuredAgentLaunchPartResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  withNativeChatVisualsEnv
} from '../../native-chat/conversation-files/native-chat-visuals-delivery'
import type { AcpLaunchSpec } from './acp-launch-contract'
import { acpLaunchSpecForAccount, resolveAcpLaunchCommand } from './acp-launch-command'
import { homeBeforeFirstTurn } from './acp-launch-home-before-first-turn'
import {
  nothingExchangedOn,
  type SavedProviderTurnReads
} from '../../native-chat/agent-session-journal/journal-provider-turn-saved'
import {
  childEnvironmentView,
  loadAcpSkillRoots,
  type AcpLaunchVisualsDeps
} from './acp-structured-launch-skill-roots'
import { linkedSkillsSection } from '../../native-chat/native-chat-skill-roots'
import { noteManagedServerUse } from '../../node-runtime/managed-runtime-release'
import type { AcpInstructionsLaunch } from './acp-instructions'
import { acpInstructionsWithVisuals, visualsByInstructions } from './acp-visuals-instructions'
import { withoutCallerIdentity } from '../../runtime/agent-session/environment/structured-session-child-env'

/** The environment a launch's process gets; see `AcpLaunchSpec.sharedToolProcess`. */
export function acpProcessEnvironment(
  launch: Pick<AcpStructuredLaunch, 'spec' | 'env' | 'envToDelete'>
): { env: Record<string, string>; envToDelete: string[] } {
  return launch.spec.sharedToolProcess
    ? withoutCallerIdentity(launch.env, launch.envToDelete)
    : { env: launch.env, envToDelete: launch.envToDelete }
}

export type AcpStructuredLaunch = StructuredAgentCommand & {
  spec: AcpLaunchSpec
  antigravityChatAuth?: AntigravityChatAuthConfig
  args: string[]
  cwd: string
  /** Sealed for spawns; recovery reads use the unsealed agent environment. */
  env: Record<string, string>
  envToDelete: string[]
  fullAccess: boolean
  /** See `AcpInstructionsLaunch`. */
  sessionMeta?: Record<string, unknown>
  sessionMetaOnReopen?: true
  takesSessionMeta?: AcpInstructionsLaunch['takesSessionMeta']
  sessionMetaOptional?: true
  aroundSessionOpen?: AcpInstructionsLaunch['aroundSessionOpen']
  release?: AcpInstructionsLaunch['release']
  /** The bot's own tools and `spec.ownMcpServers`, opened with each session; absent: none. */
  mcpServers?: McpServer[]
  /** The saved model the launch line carries. */
  launchModel?: string
  /** The launched program's version, when its check or managed release names it. */
  version?: string
  /** The home this launch moved the chat to, which the chat keeps from now on. */
  launchedAccountHome?: AgentSessionAccountHome
  resume: {
    sessionId: string
    key: string
    /** A chat-created session with no exchanged turn may never have been saved. */
    mayBeUnsaved: () => Promise<boolean>
    /** The writer decides which lost conversations still need warning rows. */
    lossKeys: readonly string[]
  } | null
}

export type AcpStructuredLaunchPartDeps = {
  savedSession: SavedProviderTurnReads
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
  /** The managed release's version, when the launch runs one. */
  version?: string
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
  const env: Record<string, string> = spec.account.environment(
    accountHome,
    overlayEnvironmentVariables(base, deps.resolveLaunchEnv?.(spec.agent), process.platform)
  )
  const commandSettings = deps.resolveCommandSettings?.()
  // Orca's account-type setting reaches only agy run on a home Orca owns.
  const antigravityChatAuth = launchAntigravityChatAuth(spec, commandSettings?.antigravityChatAuth)
  const envToDelete =
    spec.scrubEnvironment?.(env, deps.inheritedEnv ?? process.env, antigravityChatAuth) ?? []
  if (antigravityChatAuth) {
    Object.assign(env, await antigravityChatAuthEnvironment(antigravityChatAuth, env))
    assertStructuredAgentResolutionCurrent(deps.operation)
  }
  Object.assign(env, spec.env)
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
    const movedHome = await homeBeforeFirstTurn(agentSpec, record, basis, deps.dataDirectory)
    const accountHome = movedHome ?? record.accountHome
    const { env, envToDelete, command, prefixArgs, spec, antigravityChatAuth, version } =
      await resolveAcpLaunchInvocation(agentSpec, accountHome, {
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
    noteManagedServerUse(spec.agent, spec.managedRuntime, version)
    const cwd = await basis.launchDirectory()
    const visuals = spec.skillRoots || visualsByInstructions(spec) ? await basis.visuals() : null
    const linked = await basis.linkedSkills()
    // Only a folder with skills: these agents read it once, so a later link reaches them as a list.
    const linkedRoot = linked.projects.length > 0 ? linked.root : null
    const roots = [...(visuals ? [visuals.skill] : []), ...(linkedRoot ? [linkedRoot] : [])]
    // PATH may have changed since chat creation.
    const launchVersion = await checkAcpLaunchVersion(
      spec,
      { command, prefixArgs, cwd, env },
      roots.length > 0,
      deps.probeVersion
    )
    if (launchVersion.status === 'tooOld') {
      throw AgentCliInstallationError.tooOld(spec.agent, launchVersion)
    }
    const inherited = deps.inheritedEnv ?? process.env
    const skill = await loadAcpSkillRoots(spec, deps, {
      sessionId: identity.sessionId,
      roots,
      visualsRoot: visuals?.skill ?? null,
      version: launchVersion.version,
      env,
      envToDelete,
      inherited
    })
    const loaded = skill?.loaded ?? []
    const skillLoaded = visuals && loaded.includes(visuals.skill) ? visuals : null
    const tools = await basis.toolServers()
    // Why a bot's tools are off for this agent; its chat starts without them and is told so.
    const toolsOff = tools.servers.length > 0 ? spec.botToolsOff : undefined
    const own = await basis.instructions(
      linkedSkillsSection(
        linked.projects,
        linkedRoot && loaded.includes(linkedRoot) ? [] : linked.projects
      )
    )
    const delivered = await acpInstructionsWithVisuals(
      spec,
      deps,
      {
        sessionId: identity.sessionId,
        text: toolsOff ? [own, botToolsOffInstruction(toolsOff)].filter(Boolean).join('\n\n') : own,
        env: childEnvironmentView({ ...env, ...skill?.env }, inherited, envToDelete),
        cwd,
        version: launchVersion.version
      },
      visuals && !skillLoaded ? visuals.skill : null
    )
    const instructions = delivered.launch
    const visualsLoaded = skillLoaded ?? (delivered.visuals ? visuals : null)
    const fullAccess = basis.permissionMode === 'full-access'
    // A managed release's receipt names its version; other programs answer the check.
    const launchedVersion = version ?? launchVersion.version
    const botServers = toolsOff ? [] : acpBotMcpServers(tools)
    // Like its bot tools, a read-only session gets none of the agent's own servers.
    const ownServers = basis.readOnly
      ? []
      : ((await spec.ownMcpServers?.({
          cwd,
          env: childEnvironmentView(env, inherited, envToDelete),
          version: launchedVersion
        })) ?? [])
    // On a shared name the bot's server wins.
    const mcpServers = [
      ...botServers,
      ...ownServers.filter((own) => !botServers.some((bot) => bot.name === own.name))
    ]
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    // A load restores the conversation's own model, and a stale role there would stop the agent
    // before it opens; resumed chats apply their model through the session instead.
    const model = spec.launchesWithModel && !head ? record.options?.model : undefined
    const args = [
      ...spec.args({ fullAccess, pluginDirs: skill?.pluginDirs ?? [], model }),
      ...(skill?.args ?? []),
      ...(instructions?.args ?? [])
    ]
    return {
      launch: {
        spec,
        ...(antigravityChatAuth ? { antigravityChatAuth } : {}),
        command,
        prefixArgs,
        args: [...prefixArgs, ...args],
        fullAccess,
        ...(instructions?.sessionMeta
          ? {
              sessionMeta: instructions.sessionMeta,
              sessionMetaOnReopen: instructions.sessionMetaOnReopen,
              takesSessionMeta: instructions.takesSessionMeta,
              ...(instructions.sessionMetaOptional ? { sessionMetaOptional: true as const } : {})
            }
          : {}),
        ...(instructions?.aroundSessionOpen
          ? { aroundSessionOpen: instructions.aroundSessionOpen }
          : {}),
        ...(instructions?.release ? { release: instructions.release } : {}),
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
        ...(model ? { launchModel: model } : {}),
        ...(launchedVersion ? { version: launchedVersion } : {}),
        ...(movedHome ? { launchedAccountHome: movedHome } : {}),
        resume: head
          ? {
              sessionId: head.handle.nativeId,
              key: agentSessionProviderHandleKey(head.handle),
              mayBeUnsaved: async () =>
                head.origin === 'created' &&
                (await nothingExchangedOn(
                  deps.savedSession,
                  identity.sessionId,
                  head.handle.nativeId
                )),
              lossKeys: record.providerHandleChain.flatMap((link) =>
                link.replaces?.reason === 'restore-failed' ? [link.replaces.key] : []
              )
            }
          : null
      },
      env: withNativeChatVisualsEnv(
        withBotLaunchToolsEnv({ ...env, ...skill?.env, ...instructions?.env }, tools),
        visualsLoaded
      ),
      inheritedEnvToDelete: [
        ...envToDelete,
        // An inherited scratch directory belongs to a different chat.
        ...(visualsLoaded ? [] : [NATIVE_CHAT_SCRATCH_DIR_ENV]),
        LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
      ]
    }
  }
}
