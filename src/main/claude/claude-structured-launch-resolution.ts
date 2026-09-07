import { createHash } from 'node:crypto'
import type { EffortLevel, Options as ClaudeAgentSdkOptions } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
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

export const CLAUDE_DEFAULT_SETTING_SOURCES = ['user', 'project', 'local'] as const

export type ClaudeStructuredSdkOptions = Pick<
  ClaudeAgentSdkOptions,
  | 'includePartialMessages'
  | 'systemPrompt'
  | 'settingSources'
  | 'supportedDialogKinds'
  | 'extraArgs'
  | 'model'
  | 'effort'
  | 'sessionId'
  | 'resume'
  | 'resumeSessionAt'
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

const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

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
 * Translate the record's durable launch arguments into SDK options.
 *
 * Typed option first so a flag is never emitted twice; `extraArgs` carries
 * anything without one. A token expressible neither way is refused rather than
 * dropped — a silent drop is how this lane loses launch flags.
 */
export function claudeSdkOptionsForLaunchArgs(
  args: readonly string[]
): Pick<ClaudeStructuredSdkOptions, 'model' | 'effort' | 'extraArgs'> {
  let model: string | undefined
  let effort: EffortLevel | undefined
  const extraArgs: Record<string, string | null> = {}
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ''
    if (!token.startsWith('--') || token.length <= 2) {
      throw new Error(
        `claude launch argument ${token} has no SDK option; refusing rather than dropping it`
      )
    }
    const equals = token.indexOf('=')
    const flag = equals === -1 ? token : token.slice(0, equals)
    let value = equals === -1 ? null : token.slice(equals + 1)
    if (value === null) {
      const next = args[index + 1]
      if (next !== undefined && !next.startsWith('-')) {
        value = next
        index += 1
      }
    }
    if (flag === '--model' && value !== null) {
      model = value
    } else if (flag === '--effort' && value !== null && EFFORT_LEVELS.includes(value)) {
      effort = value as EffortLevel
    } else {
      extraArgs[flag.slice(2)] = value
    }
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {})
  }
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
  /** How long an in-flight account switch may hold a launch before it is refused. */
  authSwitchSettleTimeoutMs?: number
  /** Account state for the managed-account gate; null when it cannot be read, which refuses. */
  readManagedAccountGate?: () => ClaudeManagedAccountGateSettings | null
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
    if (record.accountHome.variable !== 'CLAUDE_CONFIG_DIR') {
      throw new Error(`claude sessions pin CLAUDE_CONFIG_DIR, not ${record.accountHome.variable}`)
    }
    // Every acquisition, not just the first: the account state can change under a live session, and
    // a reacquire after an unexpected exit would otherwise spawn under whatever it has become.
    // Codex has no gate here — it resolves its account on a different path.
    if (
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
    const durable = claudeSdkOptionsForLaunchArgs(record.launchArgs ?? [])
    const command = (deps.resolveCommand ?? resolveClaudeCommand)()
    const auth = await deps.resolveAuthPolicy()
    const overlay = await deps.resolveEnv?.()
    // A switch can begin while the policy and overlay resolve, exactly as it can
    // during the terminal preflight's prepareClaudeAuth — recheck after the awaits.
    await assertClaudeAuthSwitchSettled(deps.authSwitchSettleTimeoutMs)
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
      {
        ...applyClaudeEnvPatch(
          cloneDefinedEnv(process.env),
          {},
          {
            stripAuthEnv: auth.stripAuthEnv,
            platform: process.platform
          }
        ),
        ...(overlay ? cloneDefinedEnv(overlay) : {})
      },
      { platform: process.platform }
    )
    return {
      pathToClaudeCodeExecutable: command,
      options: {
        ...durable,
        ...CLAUDE_STRUCTURED_BASE_OPTIONS,
        extraArgs: { ...durable.extraArgs, ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs },
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
