import { claudeBotSessionOptions } from './claude-bot-session-options'
import { withBotLaunchToolsEnv } from '../../../bots/bot-launch-tools'
import type { ClaudeAccountRecipe } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import { prepareClaudeLaunchAccount, withClaudeLaunchAccountPin } from './claude-launch-account'
import { assertStructuredAgentResolutionCurrent } from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import { activeProviderContext } from '../../../../shared/agent-session/conversation-context/agent-session-provider-context'
import { getClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type {
  Options as ClaudeAgentSdkOptions,
  PermissionMode
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentChatPermissionChoice,
  AgentChatPermissionMode
} from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot,
  claudeProviderHandleLeafUuid
} from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { ClaudeStructuredAuthPolicy } from '../../../claude-accounts/runtime-auth/claude-structured-auth-policy'
import {
  claudeChildEnv,
  claudeProbeEnv,
  resolveClaudeChildEnvSources,
  type ClaudeChildEnvSources,
  type ClaudeEnvDeps
} from './claude-structured-child-env'
import { withClaudeArtifactDefault } from './claude-artifact-env'
import { CLAUDE_DEFAULT_SETTING_SOURCES, claudeDiscoveryOptions } from './claude-discovery-options'
import { claudeInChromeDefaultArgs } from '../../configuration/claude-in-chrome-default'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import type {
  ClaudeCliFlagCheck,
  ClaudeCliFlagSupport
} from '../../cli-capabilities/claude-cli-flag-support'
import { resolveClaudeLaunchFlags } from './claude-structured-launch-flags'
import { withNativeChatVisualsEnv } from '../../../native-chat/conversation-files/native-chat-visuals-delivery'
import { claudeLaunchResumesTranscript } from './claude-structured-launch-home'
import type { StructuredAgentLaunchPartResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition'
import { claudeSessionIdForOrcaSession } from '../lifecycle/claude-structured-session-id'
import {
  pendingAgentSessionRewindFork,
  type AgentSessionRewindFork
} from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'

export const CLAUDE_SESSION_STATE_EVENTS_ENV = 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS'
type ClaudePermissionOptions = Pick<ClaudeAgentSdkOptions, 'permissionMode' | 'extraArgs'>

export type ClaudeStructuredSdkOptions = Pick<
  ClaudeAgentSdkOptions,
  | 'includePartialMessages'
  | 'systemPrompt'
  | 'settingSources'
  | 'supportedDialogKinds'
  | 'additionalDirectories'
  | 'plugins'
  | 'model'
  | 'effort'
  | 'allowDangerouslySkipPermissions'
  | 'settings'
  | 'sessionId'
  | 'resume'
  | 'resumeSessionAt'
  | 'forkSession'
> &
  ClaudePermissionOptions & { promptSuggestions?: boolean } & Awaited<
    ReturnType<typeof claudeBotSessionOptions>
  >

/** Replay acknowledgements require an explicit flag; the SDK supplies the other transport flags. */
export const CLAUDE_STRUCTURED_BASE_OPTIONS: ClaudeStructuredSdkOptions = {
  includePartialMessages: true,
  // Keep the SDK on Claude Code's own system-prompt contract.
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  settingSources: [...CLAUDE_DEFAULT_SETTING_SOURCES],
  supportedDialogKinds: [],
  extraArgs: { 'replay-user-messages': null }
}

const CLAUDE_PERMISSION_MODES = {
  // Override settings defaultMode so the chat runs with its selected permission mode.
  ask: 'default',
  'accept-edits': 'acceptEdits',
  auto: 'auto'
} as const satisfies Record<Exclude<AgentChatPermissionMode, 'full-access'>, PermissionMode>

/** Full access is the owned CLI flag: the SDK's typed bypass emits a flag older binaries reject. */
export function claudeStructuredPermissionOptions(
  mode: AgentChatPermissionChoice
): ClaudePermissionOptions {
  if (mode === 'own') {
    // An omitted mode lets the CLI apply the user's settings defaultMode.
    return {}
  }
  return mode === 'full-access'
    ? { extraArgs: { 'dangerously-skip-permissions': null } }
    : { permissionMode: CLAUDE_PERMISSION_MODES[mode] }
}

export type ClaudeStructuredLaunch = {
  /** Always Orca's resolved user CLI: the SDK's bundled binaries are excluded from the install. */
  pathToClaudeCodeExecutable: string
  prefixArgs?: readonly string[]
  account?: ClaudeStructuredInvocation['account']
  options: ClaudeStructuredSdkOptions
  cwd: string
  env?: Record<string, string>
  envToDelete?: readonly string[]
  claudeConfigDir: string
  accountRecipe?: ClaudeAccountRecipe
  providerSessionId: string
  /** The previous head leaf, carried into the publication link; never a resume argument. */
  resumeLeafUuid: string | null
  /** Whether this launch resumes an existing Claude transcript. */
  resumesTranscript: boolean
  /** Version-gated flag and control support of the CLI this launch runs. */
  cliFlag: ClaudeCliFlagCheck
  /** Chain identity is independent of whether a transcript exists to resume. */
  continuesChain: boolean
  /** Chain head replaced by this rewind fork. */
  forkedFromKey?: string
}

export type ClaudeStructuredLaunchPartDeps = {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  resolveCommand?: ClaudeEnvDeps['resolveCommand']
  /** Explicit policy identifies the account for sign-in errors; use claudeStructuredAuthPolicyForSettings. */
  resolveAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  /** Host attachment store outside the workspace, granted to the agent at launch. */
  attachmentDirectory?: string
  /** Omit version-gated flags when support cannot be checked. */
  cliFlags?: Pick<ClaudeCliFlagSupport, 'check'>
  /** This host's setting for suggested next prompts, read at each spawn; absent means off. */
  promptSuggestions?: () => boolean
  /** Whether Claude wrote a transcript for this id; defaults to the transcript resolver. */
  hasTranscript?: (input: {
    providerSessionId: string
    claudeConfigDir: string
  }) => Promise<boolean>
}

export type ClaudeStructuredInvocation = {
  command: string
  prefixArgs: string[]
  env: Record<string, string>
  account: 'managed' | 'system'
}

/** Share binary/env resolution with catalog probes; inherited env drift heals on refresh. */
export async function resolveClaudeStructuredInvocation(
  deps: ClaudeEnvDeps & Pick<ClaudeStructuredLaunchPartDeps, 'resolveAuthPolicy'>,
  decorateEnv: (env: Record<string, string>) => Record<string, string> = (env) => env,
  /** Already resolved by a caller that needed them earlier; read again otherwise. */
  resolvedSources?: ClaudeChildEnvSources,
  options?: Parameters<typeof claudeChildEnv>[2]
): Promise<ClaudeStructuredInvocation> {
  const sources = resolvedSources ?? (await resolveClaudeChildEnvSources(deps))
  assertStructuredAgentResolutionCurrent(deps.operation)
  deps.signal?.throwIfAborted()
  const auth = await deps.resolveAuthPolicy()
  assertStructuredAgentResolutionCurrent(deps.operation)
  deps.signal?.throwIfAborted()
  // Preserve proxy credentials alongside ANTHROPIC_BASE_URL for every account.
  return {
    command: sources.command,
    prefixArgs: sources.prefixArgs,
    env: claudeChildEnv(sources, decorateEnv, options),
    account: auth.account
  }
}

export function claudeStructuredLaunchPart(
  deps: ClaudeStructuredLaunchPartDeps
): StructuredAgentLaunchPartResolver<ClaudeStructuredLaunch> {
  return async (basis, identity) => {
    const { record } = basis
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const router = getClaudeProfileRouter()
    const active = activeProviderContext(record)
    const head = active.head?.handle ?? null
    if (
      head &&
      (!identity.providerHandle ||
        agentSessionProviderHandleRoot(identity.providerHandle) !==
          agentSessionProviderHandleRoot(head))
    ) {
      throw new Error('claude durable resume identity changed before spawn')
    }
    const fork = pendingAgentSessionRewindFork(record.rewind, head?.nativeId)
    const providerSessionId = fork
      ? fork.sessionId
      : head
        ? head.nativeId
        : claudeSessionIdForOrcaSession(
            identity.sessionId,
            active.pendingClear ? record.providerContextBoundary?.operationId : undefined
          )
    const continuesChain = head?.nativeId === providerSessionId
    const cwd = await basis.launchDirectory()
    const envDeps: ClaudeEnvDeps & Pick<ClaudeStructuredLaunchPartDeps, 'resolveAuthPolicy'> = {
      ...(deps.resolveCommand ? { resolveCommand: deps.resolveCommand } : {}),
      resolveEnv: () => basis.launchEnv(),
      resolveInheritedEnv: basis.baseEnvironment,
      refreshEnvironmentAfterMiss: basis.refreshAfterMissingProgram,
      resolveWorkingDirectory: () => cwd,
      resolveAuthPolicy: deps.resolveAuthPolicy
    }
    const sources = await resolveClaudeChildEnvSources(envDeps)
    // Overlap the version probe with remaining launch preparation.
    const probeLaunch = {
      command: sources.command,
      prefixArgs: sources.prefixArgs,
      cwd,
      env: await withClaudeLaunchAccountPin(router, claudeProbeEnv(sources), accountHome.path)
    }
    const launchFlags = resolveClaudeLaunchFlags(
      { ...deps, prepareVisuals: basis.visuals },
      record.sessionId,
      probeLaunch
    )
    const launchArgs = await deps.resolveLaunchArgs()
    const { thinkingDisplayArgs, visuals, promptSuggestions, refused } = await launchFlags
    const linked = await basis.linkedSkills()
    const discovery = claudeDiscoveryOptions({
      configuredArgs: launchArgs,
      ...(deps.attachmentDirectory ? { attachmentDirectory: deps.attachmentDirectory } : {}),
      visuals: visuals && {
        pluginDir: visuals.pluginDir,
        scratchDirectory: visuals.visuals.folder
      },
      linkedRoot: linked.root
    })
    const permission = claudeStructuredPermissionOptions(basis.permissionMode ?? 'ask')
    // --resume fails without a transcript; --session-id collides with an existing one.
    const leafUuid = head && continuesChain ? claudeProviderHandleLeafUuid(head) : null
    const resumes = async (claudeConfigDir: string): Promise<boolean> =>
      (head !== null || active.pendingClear) &&
      (await claudeLaunchResumesTranscript({
        router,
        leafUuid,
        providerSessionId,
        claudeConfigDir,
        recordHome: accountHome.path,
        cwd,
        hasTranscript: deps.hasTranscript
      }))
    // Fixed homes can be checked before the final account-routing recheck.
    const resumedWithoutRouter = router ? undefined : await resumes(accountHome.path)
    // Resolve auth after awaited launch preparation; account routing is rechecked below.
    const tools = await basis.toolServers()
    const { command, prefixArgs, env } = await resolveClaudeStructuredInvocation(
      envDeps,
      (base) =>
        withNativeChatVisualsEnv(
          withBotLaunchToolsEnv(
            {
              ...withClaudeArtifactDefault(base),
              // The turn translator relies on Claude's authoritative idle frame when no result arrives.
              [CLAUDE_SESSION_STATE_EVENTS_ENV]: '1'
            },
            tools
          ),
          visuals?.visuals ?? null
        ),
      sources,
      { runtimeOnPath: false }
    )
    const accountRecipe = await prepareClaudeLaunchAccount(router, env, accountHome.path)
    const launchHome = accountRecipe.home
    // Read the config of the account directory the spawn pins, as session acquisition does.
    const chromeArgs = await claudeInChromeDefaultArgs(
      { ...env, ...claudeConfigDirEnvPatch(launchHome, { env }) },
      [...prefixArgs, ...launchArgs]
    )
    const resumesTranscript = resumedWithoutRouter ?? (await resumes(launchHome))
    if (fork?.throughEntryId && !resumesTranscript) {
      // Fork sources must pass the same account-history check as resumes.
      await claudeLaunchResumesTranscript({
        router,
        leafUuid: fork.throughEntryId,
        providerSessionId: fork.sourceSessionId,
        claudeConfigDir: launchHome,
        recordHome: accountHome.path,
        cwd,
        hasTranscript: deps.hasTranscript
      })
    }
    return {
      launch: {
        pathToClaudeCodeExecutable: command,
        prefixArgs,
        account: accountRecipe.route === 'managed' ? 'managed' : 'system',
        accountRecipe,
        options: {
          ...CLAUDE_STRUCTURED_BASE_OPTIONS,
          ...permission,
          ...discovery,
          ...(await claudeBotSessionOptions(basis, linked.projects, tools, refused)),
          ...(promptSuggestions ? { promptSuggestions } : {}),
          extraArgs: {
            ...discovery.extraArgs,
            ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs,
            ...permission.extraArgs,
            ...thinkingDisplayArgs,
            ...chromeArgs
          },
          // Claude owns where a resumed conversation continues; the stored leaf is Orca's bookkeeping.
          ...(resumesTranscript
            ? { resume: providerSessionId }
            : { sessionId: providerSessionId, ...(fork ? claudeRewindForkOptions(fork) : {}) })
        },
        claudeConfigDir: launchHome,
        providerSessionId,
        resumeLeafUuid: resumesTranscript ? leafUuid : null,
        resumesTranscript,
        cliFlag: async (flag, ...budget) =>
          deps.cliFlags ? deps.cliFlags.check(flag, probeLaunch, ...budget) : 'unknown',
        continuesChain,
        ...(fork && head && !continuesChain
          ? { forkedFromKey: agentSessionProviderHandleKey(head) }
          : {})
      },
      env,
      inheritedEnvToDelete: refused.envToDelete,
      // The agent runtime follows Orca's CLI directory on PATH so another orca cannot shadow it.
      cliRuntimeCommand: command
    }
  }
}

/** Until Claude writes the rewind's session, each launch forks it from the kept conversation. */
function claudeRewindForkOptions(
  fork: AgentSessionRewindFork
): Pick<ClaudeStructuredSdkOptions, 'resume' | 'resumeSessionAt' | 'forkSession'> {
  return fork.throughEntryId
    ? { resume: fork.sourceSessionId, resumeSessionAt: fork.throughEntryId, forkSession: true }
    : {}
}
