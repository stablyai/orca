import { activeProviderContext } from '../../shared/agent-session-provider-context'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type {
  Options as ClaudeAgentSdkOptions,
  PermissionMode
} from '@anthropic-ai/claude-agent-sdk'
import { agentSessionProviderHandleRoot } from '../../shared/agent-session-provider-handle'
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
import type {
  StructuredAgentLaunchBasis,
  StructuredAgentLaunchPart,
  StructuredLaunchRequest
} from '../runtime/structured-agent-launch-composition'
import { claudeSessionIdForOrcaSession } from './claude-structured-session-id'

export { claudeSessionIdForOrcaSession }

export const CLAUDE_DEFAULT_SETTING_SOURCES = ['user', 'project', 'local'] as const
export const CLAUDE_SESSION_STATE_EVENTS_ENV = 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS'

export type ClaudeStructuredSdkOptions = Pick<
  ClaudeAgentSdkOptions,
  | 'includePartialMessages'
  | 'systemPrompt'
  | 'settingSources'
  | 'supportedDialogKinds'
  | 'extraArgs'
  | 'additionalDirectories'
  | 'plugins'
  | 'model'
  | 'effort'
  | 'permissionMode'
  | 'allowDangerouslySkipPermissions'
  | 'settings'
  | 'sessionId'
  | 'resume'
>

/**
 * The options translation of the flags this transport used to build by hand.
 *
 * `-p`, `--input-format`, `--output-format` and `--verbose` are implied by
 * `query()`; `--permission-prompt-tool stdio` is emitted because a `canUseTool`
 * callback is supplied. `--replay-user-messages` has no option — the SDK never
 * emits it — and Orca's send acknowledgement depends on the replay.
 */
export const CLAUDE_STRUCTURED_BASE_OPTIONS: ClaudeStructuredSdkOptions = {
  includePartialMessages: true,
  // Keep the SDK on Claude Code's own system-prompt contract.
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  settingSources: [...CLAUDE_DEFAULT_SETTING_SOURCES],
  supportedDialogKinds: [],
  extraArgs: { 'replay-user-messages': null }
}

/**
 * Agent Permissions as query-start options.
 *
 * The owned CLI flag preserves the user-installed binary contract. The SDK's typed bypass option
 * emits a newer allow flag that older Claude binaries reject before a structured session starts.
 */
export function claudeStructuredPermissionOptions(
  mode: PermissionMode
): Pick<ClaudeStructuredSdkOptions, 'extraArgs'> {
  return mode === 'bypassPermissions' ? { extraArgs: { 'dangerously-skip-permissions': null } } : {}
}

export type ClaudeStructuredLaunch = {
  /** Always Orca's resolved user CLI: the SDK's bundled binaries are excluded from the install. */
  pathToClaudeCodeExecutable: string
  account?: ClaudeStructuredInvocation['account']
  options: ClaudeStructuredSdkOptions
  cwd: string
  /** The child's sealed environment, and the inherited keys it must not keep. */
  env?: Record<string, string>
  envToDelete?: readonly string[]
  claudeConfigDir: string
  providerSessionId: string
  /** The previous head leaf, carried into the publication link; never a resume argument. */
  resumeLeafUuid: string | null
  /** Launch mode: `--resume` of a transcript Claude wrote, rather than starting the id fresh. */
  resumesTranscript: boolean
  /** Lineage: the record's chain already heads this provider session, so the child continues it
   *  even when no transcript exists to `--resume`. Never derived from the launch mode. */
  continuesChain: boolean
}

export type ClaudeStructuredLaunchPartDeps = {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  resolveCommand?: () => string
  /** Required, so every caller states which login a failed sign-in names rather than inherit a
   *  guess. Build it with claudeStructuredAuthPolicyForSettings. */
  resolveAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  /** The user's Agent Permissions setting, re-read per acquisition. Absent means prompting. */
  resolvePermissionMode?: () => Promise<PermissionMode> | PermissionMode
  /** The host's chat attachment store: files a client attached live there, outside the workspace,
   *  and the agent reads them without asking. */
  attachmentDirectory?: string
  /** Which version-gated flags this CLI takes. Absent ⇒ none is ever passed. */
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

/**
 * The one place a structured Claude child's binary and environment are
 * resolved. The session launch and the session-less catalog probe both build
 * on it, so a probe can never list under a different binary or env than the
 * session it stands in for. Env VALUES stay out of the catalog fingerprint:
 * drift there heals on the next refresh.
 */
export async function resolveClaudeStructuredInvocation(
  deps: ClaudeEnvDeps & Pick<ClaudeStructuredLaunchPartDeps, 'resolveAuthPolicy'>,
  decorateEnv: (env: Record<string, string>) => Record<string, string> = (env) => env,
  /** Already resolved by a caller that needed them earlier; read again otherwise. */
  resolvedSources?: ClaudeChildEnvSources,
  options?: Parameters<typeof claudeChildEnv>[2]
): Promise<ClaudeStructuredInvocation> {
  const sources = resolvedSources ?? (await resolveClaudeChildEnvSources(deps))
  const auth = await deps.resolveAuthPolicy()
  // Why never strip: a shell proxy's key must travel with its ANTHROPIC_BASE_URL, on every account.
  return {
    command: sources.command,
    env: claudeChildEnv(sources, decorateEnv, options),
    account: auth.account
  }
}

/** Claude's part of a launch: its resume decision, flags, permission posture, account home and
 *  auth, with the account-switch recheck last. */
export function claudeStructuredLaunchPart(
  deps: ClaudeStructuredLaunchPartDeps
): (
  basis: StructuredAgentLaunchBasis,
  request: StructuredLaunchRequest
) => Promise<StructuredAgentLaunchPart<ClaudeStructuredLaunch>> {
  return async (basis, { identity }) => {
    const { record } = basis
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const router = getClaudeProfileRouter()
    // A Claude record's chain holds only Claude handles; the launch admission refuses anything else.
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
    const providerSessionId = head
      ? head.nativeId
      : claudeSessionIdForOrcaSession(
          identity.sessionId,
          active.pendingClear ? record.providerContextBoundary?.operationId : undefined
        )
    const continuesChain = head !== null
    const cwd = await basis.launchDirectory()
    const envDeps: ClaudeEnvDeps & Pick<ClaudeStructuredLaunchPartDeps, 'resolveAuthPolicy'> = {
      ...(deps.resolveCommand ? { resolveCommand: deps.resolveCommand } : {}),
      resolveEnv: () => basis.launchEnv(),
      resolveInheritedEnv: basis.baseEnvironment,
      resolveAuthPolicy: deps.resolveAuthPolicy
    }
    const sources = await resolveClaudeChildEnvSources(envDeps)
    // Asked as soon as the spawn's cwd and PATH are known, so it overlaps what is left to resolve.
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
    const permission = claudeStructuredPermissionOptions(
      (await deps.resolvePermissionMode?.()) ?? 'default'
    )
    // A start that failed before its first turn wrote no transcript, and `--resume` of an absent
    // one exits; launch that id fresh instead. With a transcript, `--session-id` would collide.
    const leafUuid = head ? claudeProviderHandleLeafUuid(head) : null
    const resumes = async (claudeConfigDir: string): Promise<boolean> =>
      (head !== null || active.pendingClear) &&
      (await claudeLaunchResumesTranscript({
        router,
        leafUuid,
        providerSessionId,
        claudeConfigDir,
        hasTranscript: deps.hasTranscript
      }))
    // Why: without a router the home is fixed, so check it before the recheck that must stay last.
    const resumedWithoutRouter = router ? undefined : await resumes(accountHome.path)
    // Last: it rechecks the account switch, which may have begun during any await above.
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
          ...(resumesTranscript ? { resume: providerSessionId } : { sessionId: providerSessionId })
        },
        claudeConfigDir: launchHome,
        providerSessionId,
        resumeLeafUuid: resumesTranscript ? leafUuid : null,
        resumesTranscript,
        continuesChain
      },
      env,
      // Every structured session speaks orchestration as itself; Claude strips no inherited key.
      inheritedEnvToDelete: [],
      // Its own runtime's directory goes ahead of this app's CLI directory on PATH.
      cliRuntimeCommand: command
    }
  }
}
