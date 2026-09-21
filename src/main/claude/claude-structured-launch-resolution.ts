import { createHash } from 'node:crypto'
import type {
  Options as ClaudeAgentSdkOptions,
  PermissionMode
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { structuredWorkerChildIdentityEnv } from '../runtime/structured-worker-child-identity-env'
import {
  CLAUDE_AUTH_ENV_CONFLICT_MESSAGE,
  CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE,
  applyClaudeEnvPatch,
  hasClaudeAuthEnvConflict
} from '../claude-accounts/environment'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import {
  CLAUDE_AUTH_SWITCH_SETTLE_TIMEOUT_MS,
  whenClaudeAuthSwitchSettles
} from '../claude-accounts/live-pty-gate'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  structuredClaudeMatchesActiveManagedAccount,
  type ClaudeManagedAccountGateSettings
} from '../native-chat/claude-structured-managed-account-support'
import { resolveClaudeCommand } from '../codex-cli/command'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import {
  ClaudeBoundHomeRefusalError,
  assertClaudeBoundHomeUsable,
  type AssertClaudeBoundHomeUsable
} from './claude-bound-home-refusal'
import { sameClaudeConfigDir } from './claude-config-dir-identity'
import { isCustomClaudeConfigDir } from './claude-config-dir-pin'
import { claudeChildLaunchEnv, isEffectiveBoundClaudeHome } from './claude-structured-account-home'
import type { ResolvedClaudeHomeBinding } from '../../shared/claude-home-binding'

export const CLAUDE_DEFAULT_SETTING_SOURCES = ['user', 'project', 'local'] as const
export const CLAUDE_SESSION_STATE_EVENTS_ENV = 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS'

export type ClaudeStructuredSdkOptions = Pick<
  ClaudeAgentSdkOptions,
  | 'includePartialMessages'
  | 'systemPrompt'
  | 'settingSources'
  | 'supportedDialogKinds'
  | 'extraArgs'
  | 'model'
  | 'effort'
  | 'permissionMode'
  | 'allowDangerouslySkipPermissions'
  | 'sessionId'
  | 'resume'
  | 'resumeSessionAt'
  | 'resumeDropsTurn'
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

function cloneDefinedEnv(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
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
  options: ClaudeStructuredSdkOptions
  cwd: string
  env?: Record<string, string>
  claudeConfigDir: string
  providerSessionId: string
  resumeLeafUuid: string | null
  resumed: boolean
}

export type ClaudeStructuredLaunchResolverDeps = {
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCommand?: () => string
  resolveEnv?: () =>
    | Promise<Record<string, string> | undefined>
    | Record<string, string>
    | undefined
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
  /** Re-proves a bound home per acquisition. Overridden only by tests. */
  assertBoundHomeUsable?: AssertClaudeBoundHomeUsable
  /**
   * The binding this workspace's group carries *now*. The account home is pinned when the chat is
   * created and a resume rebuilds it verbatim, so a binding added afterwards never reaches an
   * existing chat — this is what lets the launch say so instead of billing the old account
   * silently. Absent leaves the check off, for embedders with no project catalog.
   */
  readClaudeHomeBinding?: (location: {
    workspaceId: string
    executionHostId: string
  }) => ResolvedClaudeHomeBinding | null
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
    throw new Error(CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE)
  }
}

export function claudeSessionIdForOrcaSession(sessionId: string): string {
  const bytes = createHash('sha256').update(`orca-claude:${sessionId}`).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createClaudeStructuredLaunchResolver(
  deps: ClaudeStructuredLaunchResolverDeps
): (input: { identity: AgentSessionJournalIdentity }) => Promise<ClaudeStructuredLaunch> {
  return async ({ identity }) => {
    // Resolved first because every check below that has to agree with the config-dir pin reads the
    // environment the child actually receives, not the overlay alone.
    const overlay = await deps.resolveEnv?.()
    const childEnv = claudeChildLaunchEnv(overlay)
    const record = deps.store.getRecord(identity.sessionId)
    // A project-group binding to a *custom* home is not a managed one: it does not read the shared
    // runtime auth a switch mutates, and the active managed selection does not describe it. Both
    // the switch gate and the managed-account gate therefore have nothing to say about it. A
    // binding that resolves to the home the CLI would find anyway is none of that — it pins
    // nothing, so it keeps every gate, decided by the one predicate all three readers share.
    const boundHome = record
      ? isEffectiveBoundClaudeHome(record.accountHome, { env: childEnv })
      : false
    // Ahead of the record validations, exactly where it sat before the bound branch existed: an
    // unbound caller's error precedence is unchanged.
    if (!boundHome) {
      await assertClaudeAuthSwitchSettled(deps.authSwitchSettleTimeoutMs)
    }
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
    if (record.accountHome.variable !== 'CLAUDE_CONFIG_DIR') {
      throw new Error(`claude sessions pin CLAUDE_CONFIG_DIR, not ${record.accountHome.variable}`)
    }
    // Every acquisition, not just the first: the account state can change under a live session, and
    // a reacquire after an unexpected exit would otherwise spawn under whatever it has become.
    // Codex has no gate here — it resolves its account on a different path.
    if (
      !boundHome &&
      deps.readManagedAccountGate &&
      !structuredClaudeMatchesActiveManagedAccount(deps.readManagedAccountGate())
    ) {
      throw new AgentSessionPreSpawnError(
        'structured Claude is not offered under the active managed Claude account'
      )
    }
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (
      head?.handle.provider === 'claude' &&
      (identity.providerHandle.kind !== 'claude' ||
        identity.providerHandle.sessionId !== head.handle.sessionId ||
        identity.providerHandle.leafUuid !== head.handle.leafUuid)
    ) {
      throw new Error('claude durable resume identity changed before spawn')
    }
    const providerSessionId =
      head?.handle.provider === 'claude'
        ? head.handle.sessionId
        : claudeSessionIdForOrcaSession(identity.sessionId)
    // `record.launchArgs` is deliberately not read: the configured CLI arguments are a terminal
    // concern, and the permission mode they used to smuggle in is an owned provider option now.
    const permission = claudeStructuredPermissionOptions(
      (await deps.resolvePermissionMode?.()) ?? 'default'
    )
    const command = (deps.resolveCommand ?? resolveClaudeCommand)()
    const auth = await deps.resolveAuthPolicy()
    // A switch can begin while the env, policy and permission mode resolve, exactly as it can
    // during the terminal preflight's prepareClaudeAuth — recheck after the awaits.
    if (!boundHome) {
      await assertClaudeAuthSwitchSettled(deps.authSwitchSettleTimeoutMs)
    }
    // The same "every acquisition" rule the two skipped gates carried: a bound directory that has
    // been deleted or signed out since the create refuses by name here rather than spawning an
    // unauthenticated child against whatever the path has become.
    const binding = record.accountHome.binding
    if (boundHome && binding) {
      await (deps.assertBoundHomeUsable ?? assertClaudeBoundHomeUsable)({
        binding: { configDir: record.accountHome.path, groupId: binding.groupId },
        location: {
          executionHostId: record.location.executionHostId,
          wslDistro: record.location.wslDistro
        },
        launchEnv: childEnv
      })
    }
    // A binding the group gained after this chat was created cannot be applied to it — the
    // conversation's transcript lives under the home it was pinned to — so the user is told rather
    // than left believing the group setting reached every chat in it.
    const groupBinding = deps.readClaudeHomeBinding?.({
      workspaceId: record.location.workspaceId,
      executionHostId: record.location.executionHostId
    })
    if (
      groupBinding &&
      isCustomClaudeConfigDir(groupBinding.configDir, { env: childEnv }) &&
      !sameClaudeConfigDir(groupBinding.configDir, record.accountHome.path)
    ) {
      throw new ClaudeBoundHomeRefusalError({
        code: 'claude_bound_home_predates_binding',
        groupId: groupBinding.groupId,
        configDir: groupBinding.configDir,
        accountHomePath: record.accountHome.path
      })
    }
    // Under a managed account the pinned credential is the only auth this launch may
    // use, so an explicit override is refused rather than silently beating the pin.
    if (auth.stripAuthEnv && hasClaudeAuthEnvConflict(overlay)) {
      throw new Error(CLAUDE_AUTH_ENV_CONFLICT_MESSAGE)
    }
    // Why the overlay merges onto the inherited env rather than replacing it: the child
    // still needs PATH and the rest of the shell environment, and withCliRuntimeOnPath
    // derives PATH from what it is handed. Ambient Anthropic auth is stripped from the
    // inherited half only when a managed account owns the credential; a system-auth
    // user's own key is their sign-in and must reach the child.
    const env = withCliRuntimeOnPath(
      command,
      // Only a dispatched structured worker gets the orchestration identity and the Orca CLI on
      // PATH; an ordinary chat session's env passes through untouched.
      structuredWorkerChildIdentityEnv(record.sessionId, {
        ...applyClaudeEnvPatch(
          cloneDefinedEnv(process.env),
          {},
          {
            stripAuthEnv: auth.stripAuthEnv,
            platform: process.platform
          }
        ),
        ...(overlay ? cloneDefinedEnv(overlay) : {}),
        // The turn translator relies on Claude's authoritative idle frame when no result arrives.
        [CLAUDE_SESSION_STATE_EVENTS_ENV]: '1'
      }),
      { platform: process.platform }
    )
    return {
      pathToClaudeCodeExecutable: command,
      options: {
        ...CLAUDE_STRUCTURED_BASE_OPTIONS,
        ...permission,
        extraArgs: { ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs, ...permission.extraArgs },
        ...(head?.handle.provider === 'claude'
          ? {
              resume: providerSessionId,
              ...(head.handle.leafUuid === null ? {} : { resumeSessionAt: head.handle.leafUuid })
            }
          : { sessionId: providerSessionId })
      },
      cwd: await deps.resolveWorkspacePath(record.location.workspaceId),
      env,
      claudeConfigDir: record.accountHome.path,
      providerSessionId,
      resumeLeafUuid: head?.handle.provider === 'claude' ? head.handle.leafUuid : null,
      resumed: head?.handle.provider === 'claude'
    }
  }
}
