import { activeProviderContext } from '../../shared/agent-session-provider-context'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type {
  Options as ClaudeAgentSdkOptions,
  PermissionMode
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentChatPermissionChoice,
  AgentChatPermissionMode
} from '../../shared/agent-chat-permission-mode'
import {
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot
} from '../../shared/agent-session-provider-handle'
import { claudeProviderHandleLeafUuid } from '../../shared/agent-session-provider-handle-encoding'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import {
  claudeChildEnv,
  claudeProbeEnv,
  resolveClaudeChildEnvSources,
  type ClaudeChildEnvSources,
  type ClaudeEnvDeps
} from './claude-structured-child-env'
import { claudeStructuredLaunchArgs } from './claude-structured-launch-args'
import type { ClaudeCliFlagSupport } from './claude-cli-flag-support'
import { resolveClaudeLaunchFlags } from './claude-structured-launch-flags'
import { withNativeChatVisualsEnv } from '../native-chat/native-chat-visuals-delivery'
import {
  claudeLaunchResumesTranscript,
  resolveClaudeStructuredLaunchHome
} from './claude-structured-launch-home'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'
import { claudeSessionIdForOrcaSession } from './structured/claude-structured-session-id'
import {
  pendingAgentSessionRewindFork,
  type AgentSessionRewindFork
} from '../../shared/agent-session-rewind'

export const CLAUDE_DEFAULT_SETTING_SOURCES = ['user', 'project', 'local'] as const
export const CLAUDE_SESSION_STATE_EVENTS_ENV = 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS'

type ClaudePermissionOptions = Pick<ClaudeAgentSdkOptions, 'permissionMode' | 'extraArgs'> & {
  resolvePermissionModeInCli?: true
}

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
  ClaudePermissionOptions

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
    // upstream request: https://github.com/anthropics/claude-agent-sdk-typescript/issues/519
    return { resolvePermissionModeInCli: true }
  }
  return mode === 'full-access'
    ? { extraArgs: { 'dangerously-skip-permissions': null } }
    : { permissionMode: CLAUDE_PERMISSION_MODES[mode] }
}

export type ClaudeStructuredLaunch = {
  /** Always Orca's resolved user CLI: the SDK's bundled binaries are excluded from the install. */
  pathToClaudeCodeExecutable: string
  account?: ClaudeStructuredInvocation['account']
  options: ClaudeStructuredSdkOptions
  cwd: string
  env?: Record<string, string>
  envToDelete?: readonly string[]
  claudeConfigDir: string
  providerSessionId: string
  /** The previous head leaf, carried into the publication link; never a resume argument. */
  resumeLeafUuid: string | null
  /** Whether this launch resumes an existing Claude transcript. */
  resumesTranscript: boolean
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
  cliFlags?: Pick<ClaudeCliFlagSupport, 'supports'>
  /** Whether Claude wrote a transcript for this id; defaults to the transcript resolver. */
  hasTranscript?: (input: {
    providerSessionId: string
    claudeConfigDir: string
  }) => Promise<boolean>
}

export type ClaudeStructuredInvocation = {
  command: string
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
  deps.signal?.throwIfAborted()
  const auth = await deps.resolveAuthPolicy()
  deps.signal?.throwIfAborted()
  // Preserve proxy credentials alongside ANTHROPIC_BASE_URL for every account.
  return {
    command: sources.command,
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
    const probeLaunch = { command: sources.command, cwd, env: claudeProbeEnv(sources) }
    const launchFlags = resolveClaudeLaunchFlags(
      { ...(deps.cliFlags ? { cliFlags: deps.cliFlags } : {}), prepareVisuals: basis.visuals },
      record.sessionId,
      probeLaunch
    )
    const configured = claudeStructuredLaunchArgs(await deps.resolveLaunchArgs())
    const { thinkingDisplayArgs, visuals } = await launchFlags
    const additionalDirectories = [
      ...configured.additionalDirectories,
      ...(deps.attachmentDirectory ? [deps.attachmentDirectory] : []),
      ...(visuals ? [visuals.visuals.folder] : [])
    ]
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
        hasTranscript: deps.hasTranscript
      }))
    // Fixed homes can be checked before the final account-routing recheck.
    const resumedWithoutRouter = router ? undefined : await resumes(accountHome.path)
    // Resolve auth after awaited launch preparation; account routing is rechecked below.
    const { command, env, account } = await resolveClaudeStructuredInvocation(
      envDeps,
      (base) =>
        withNativeChatVisualsEnv(
          {
            ...base,
            // The turn translator relies on Claude's authoritative idle frame when no result arrives.
            [CLAUDE_SESSION_STATE_EVENTS_ENV]: '1'
          },
          visuals?.visuals ?? null
        ),
      sources,
      { runtimeOnPath: false }
    )
    const launchHome = await resolveClaudeStructuredLaunchHome(router, env, accountHome.path)
    const resumesTranscript = resumedWithoutRouter ?? (await resumes(launchHome))
    if (fork?.throughEntryId && !resumesTranscript) {
      // Fork sources must pass the same account-history check as resumes.
      await claudeLaunchResumesTranscript({
        router,
        leafUuid: fork.throughEntryId,
        providerSessionId: fork.sourceSessionId,
        claudeConfigDir: launchHome,
        hasTranscript: deps.hasTranscript
      })
    }
    return {
      launch: {
        pathToClaudeCodeExecutable: command,
        account,
        options: {
          ...CLAUDE_STRUCTURED_BASE_OPTIONS,
          ...permission,
          ...(additionalDirectories.length ? { additionalDirectories } : {}),
          ...(visuals?.pluginDir ? { plugins: [{ type: 'local', path: visuals.pluginDir }] } : {}),
          extraArgs: {
            ...configured.extraArgs,
            ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs,
            ...permission.extraArgs,
            ...thinkingDisplayArgs
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
        continuesChain,
        ...(fork && head && !continuesChain
          ? { forkedFromKey: agentSessionProviderHandleKey(head) }
          : {})
      },
      env,
      inheritedEnvToDelete: [],
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
