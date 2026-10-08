import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type {
  Options as ClaudeAgentSdkOptions,
  PermissionMode
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleRoot
} from '../../shared/agent-session-provider-handle'
import { claudeProviderHandleLeafUuid } from '../../shared/agent-session-provider-handle-encoding'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import {
  CLAUDE_AUTH_ENV_CONFLICT_MESSAGE,
  CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE,
  hasClaudeAuthEnvConflict
} from '../claude-accounts/environment'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import {
  CLAUDE_AUTH_SWITCH_SETTLE_TIMEOUT_MS,
  whenClaudeAuthSwitchSettles
} from '../claude-accounts/live-pty-gate'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  hasWslBoundClaudeAccount,
  structuredClaudeMatchesActiveManagedAccount,
  type ClaudeManagedAccountGateSettings
} from '../native-chat/claude-structured-managed-account-support'
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
import {
  withNativeChatVisualsEnv,
  type PrepareNativeChatVisuals
} from '../native-chat/native-chat-visuals-delivery'
import {
  claudeLaunchResumesTranscript,
  resolveClaudeStructuredLaunchHome
} from './claude-structured-launch-home'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { resolveAgentSessionLaunchDirectory } from '../runtime/agent-session-launch-directory'
import { CLAUDE_STRUCTURED_AGENT } from './claude-structured-agent-definition'
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
  env?: Record<string, string>
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

export type ClaudeStructuredLaunchResolverDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'pinLaunchDirectory'>
  resolveLaunchArgs: () => Promise<string[]> | string[]
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCommand?: () => string
  resolveEnv?: () =>
    | Promise<Record<string, string> | undefined>
    | Record<string, string>
    | undefined
  /** The env the child inherits before auth stripping; absent inherits Orca's own process env. */
  resolveInheritedEnv?: () => Promise<Record<string, string>>
  /**
   * Required, and deliberately not defaulted. `stripAuthEnv` used to be a literal
   * `true` here, so a missing dependency could not under-strip. Now it can, and the
   * failure is silent — so every caller states the account's policy rather than
   * inherit a guess. Build it with claudeStructuredAuthPolicyForSettings.
   */
  resolveAuthPolicy: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  /** The user's Agent Permissions setting, re-read per acquisition. Absent means prompting. */
  resolvePermissionMode?: () => Promise<PermissionMode> | PermissionMode
  /** How long an in-flight account switch may hold a launch before it is refused. */
  authSwitchSettleTimeoutMs?: number
  /** Account state for the managed-account gate; null when it cannot be read, which refuses. */
  readManagedAccountGate?: () => ClaudeManagedAccountGateSettings | null
  /** The host's chat attachment store: files a client attached live there, outside the workspace,
   *  and the agent reads them without asking. */
  attachmentDirectory?: string
  /** Which version-gated flags this CLI takes. Absent ⇒ none is ever passed. */
  cliFlags?: Pick<ClaudeCliFlagSupport, 'supports'>
  /** This chat's visuals folder and skill; absent or null ⇒ the chat gets neither. */
  prepareVisuals?: PrepareNativeChatVisuals
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
  deps: ClaudeEnvDeps &
    Pick<ClaudeStructuredLaunchResolverDeps, 'resolveAuthPolicy'> & {
      authSwitchSettleTimeoutMs?: number
    },
  decorateEnv: (env: Record<string, string>) => Record<string, string> = (env) => env,
  /** Already resolved by a caller that needed them earlier; read again otherwise. */
  resolvedSources?: ClaudeChildEnvSources
): Promise<ClaudeStructuredInvocation> {
  const sources = resolvedSources ?? (await resolveClaudeChildEnvSources(deps))
  const auth = await deps.resolveAuthPolicy()
  // A switch can begin while the policy and overlay resolve, exactly as it can
  // during the terminal preflight's prepareClaudeAuth — recheck after the awaits.
  await assertClaudeAuthSwitchSettled(deps.authSwitchSettleTimeoutMs)
  // Under a managed account the pinned credential is the only auth this launch may
  // use, so an explicit override is refused rather than silently beating the pin.
  if (auth.stripAuthEnv && hasClaudeAuthEnvConflict(sources.overlay)) {
    throw new AgentSessionPreSpawnError(new Error(CLAUDE_AUTH_ENV_CONFLICT_MESSAGE), {
      reason: 'managedAccountEnvOverride'
    })
  }
  return {
    command: sources.command,
    env: claudeChildEnv(sources, auth.stripAuthEnv, decorateEnv),
    account: auth.stripAuthEnv ? 'managed' : 'system'
  }
}

/**
 * Wait a running account switch out, and refuse only if it never settles.
 *
 * Launch resolution is reached from `acquireClaudeSession` *after* the old child has
 * been closed and proved, so a plain refusal here would leave the user with a dead
 * chat and no replacement — the very harm the acquire-entry guard exists to prevent.
 * The entry guard still refuses outright, because nothing has been torn down yet.
 */
export async function assertClaudeAuthSwitchSettled(
  timeoutMs = CLAUDE_AUTH_SWITCH_SETTLE_TIMEOUT_MS
): Promise<void> {
  if (!(await whenClaudeAuthSwitchSettles(timeoutMs))) {
    throw new AgentSessionPreSpawnError(new Error(CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE), {
      reason: 'accountSwitchInProgress'
    })
  }
}

export function createClaudeStructuredLaunchResolver(
  deps: ClaudeStructuredLaunchResolverDeps
): (input: { identity: AgentSessionJournalIdentity }) => Promise<ClaudeStructuredLaunch> {
  return async ({ identity }) => {
    await assertClaudeAuthSwitchSettled(deps.authSwitchSettleTimeoutMs)
    const record = deps.store.getRecord(identity.sessionId)
    if (!record) {
      throw new Error(`no durable agent-session record for ${identity.sessionId}`)
    }
    if (record.provider !== 'claude') {
      throw new Error(`session ${identity.sessionId} is a ${record.provider} session`)
    }
    if (
      record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      record.location.wslDistro !== null
    ) {
      throw new Error(
        `claude structured sessions run on the local host, not ${record.location.executionHostId}`
      )
    }
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const pinned = CLAUDE_STRUCTURED_AGENT.accountHomeVariable
    if (accountHome.variable !== pinned) {
      throw new Error(`claude sessions pin ${pinned}, not ${accountHome.variable}`)
    }
    // Every acquisition, not just the first: the account state can change under a live session, and
    // a reacquire after an unexpected exit would otherwise spawn under whatever it has become.
    // Codex has no gate here — it resolves its account on a different path.
    const router = getClaudeProfileRouter()
    const gate = router ? undefined : deps.readManagedAccountGate?.()
    if (gate !== undefined && !structuredClaudeMatchesActiveManagedAccount(gate)) {
      // Unreadable account state names no situation a person can act on, so only the log reads it.
      throw new AgentSessionPreSpawnError(
        'structured Claude is not offered under the active managed Claude account',
        gate && hasWslBoundClaudeAccount(gate) ? { reason: 'managedAccountUnsupported' } : {}
      )
    }
    // A Claude record's chain holds only Claude handles; the attach admission refuses anything else.
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle ?? null
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
      : claudeSessionIdForOrcaSession(identity.sessionId)
    const continuesChain = head !== null
    const cwd = await resolveAgentSessionLaunchDirectory(deps, record)
    const sources = await resolveClaudeChildEnvSources(deps)
    // Asked as soon as the spawn's cwd and PATH are known, so it overlaps what is left to resolve.
    const probeLaunch = { command: sources.command, cwd, env: claudeProbeEnv(sources) }
    const launchFlags = resolveClaudeLaunchFlags(deps, record.sessionId, probeLaunch)
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
      head !== null &&
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
      deps,
      (base) =>
        // Every structured session speaks orchestration as itself: its injected id and the Orca CLI.
        structuredSessionChildIdentityEnv(
          record.sessionId,
          withNativeChatVisualsEnv(
            {
              ...base,
              // The turn translator relies on Claude's authoritative idle frame when no result arrives.
              [CLAUDE_SESSION_STATE_EVENTS_ENV]: '1'
            },
            visuals?.visuals ?? null
          )
        ),
      sources
    )
    const launchHome = await resolveClaudeStructuredLaunchHome(router, env, accountHome.path)
    const resumesTranscript = resumedWithoutRouter ?? (await resumes(launchHome))
    return {
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
      cwd,
      env,
      claudeConfigDir: launchHome,
      providerSessionId,
      resumeLeafUuid: resumesTranscript ? leafUuid : null,
      resumesTranscript,
      continuesChain
    }
  }
}
