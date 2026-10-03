import { getClaudeProfileRoutingAuthority } from '../claude-accounts/claude-profile-routing-authority'
import {
  ClaudeProfileIdentityRefusalError,
  ClaudeProfileSignInRequiredError
} from '../claude-accounts/claude-profile-routing-owner'
import type { ClaudeProfileRoutingService } from '../claude-accounts/claude-profile-routing-service'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth/runtime-auth-types'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type {
  Options as ClaudeAgentSdkOptions,
  PermissionMode
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { agentSessionLaunchAccountHome } from '../runtime/agent-session-launch-account-home'
import { resolveStructuredClaudeAccountHomePath } from '../runtime/structured-agent-account-home'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import {
  CLAUDE_AUTH_ENV_CONFLICT_MESSAGE,
  applyClaudeEnvPatch,
  hasClaudeAuthEnvConflict
} from '../claude-accounts/environment'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  hasWslBoundClaudeAccount,
  structuredClaudeMatchesActiveManagedAccount,
  type ClaudeManagedAccountGateSettings
} from '../native-chat/claude-structured-managed-account-support'
import { resolveClaudeCommand } from '../codex-cli/command'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'

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
  /** The previous head leaf, carried into the publication link; never a resume argument. */
  resumeLeafUuid: string | null
  /** Launch mode: `--resume` of a transcript Claude wrote, rather than starting the id fresh. */
  resumesTranscript: boolean
  /** Lineage: the record's chain already heads this provider session, so the child continues it
   *  even when no transcript exists to `--resume`. Never derived from the launch mode. */
  continuesChain: boolean
}

export type ClaudeStructuredLaunchResolverDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'transitionHandoff'>
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
  /** Account state for the managed-account gate; null when it cannot be read, which refuses. */
  readManagedAccountGate?: () => ClaudeManagedAccountGateSettings | null
  /** Whether Claude wrote a transcript for this id; defaults to the transcript resolver. */
  hasTranscript?: (input: {
    providerSessionId: string
    claudeConfigDir: string
  }) => Promise<boolean>
}

async function claudeTranscriptExists(input: {
  providerSessionId: string
  claudeConfigDir: string
}): Promise<boolean> {
  const path = await resolveSessionFilePath('claude', input.providerSessionId, {
    claudeProjectsDir: join(input.claudeConfigDir, 'projects')
  })
  return path !== null
}

export type ClaudeStructuredInvocation = { command: string; env: Record<string, string> }

/**
 * The one place a structured Claude child's binary and environment are
 * resolved. The session launch and the session-less catalog probe both build
 * on it, so a probe can never list under a different binary or env than the
 * session it stands in for. Env VALUES stay out of the catalog fingerprint:
 * drift there heals on the next refresh.
 */
export async function resolveClaudeStructuredInvocation(
  deps: Pick<
    ClaudeStructuredLaunchResolverDeps,
    'resolveCommand' | 'resolveEnv' | 'resolveInheritedEnv' | 'resolveAuthPolicy'
  >,
  decorateEnv: (env: Record<string, string>) => Record<string, string> = (env) => env
): Promise<ClaudeStructuredInvocation> {
  const command = (deps.resolveCommand ?? resolveClaudeCommand)()
  const auth = await deps.resolveAuthPolicy()
  const overlay = await deps.resolveEnv?.()
  const inheritedEnv = deps.resolveInheritedEnv
    ? await deps.resolveInheritedEnv()
    : cloneDefinedEnv(process.env)
  // Under a managed account the pinned credential is the only auth this launch may
  // use, so an explicit override is refused rather than silently beating the pin.
  if (auth.stripAuthEnv && hasClaudeAuthEnvConflict(overlay)) {
    throw new AgentSessionPreSpawnError(new Error(CLAUDE_AUTH_ENV_CONFLICT_MESSAGE), {
      reason: 'managedAccountEnvOverride'
    })
  }
  // Why the overlay merges onto the inherited env rather than replacing it: the child
  // still needs PATH and the rest of the shell environment, and withCliRuntimeOnPath
  // derives PATH from what it is handed. Ambient Anthropic auth is stripped from the
  // inherited half only when a managed account owns the credential; a system-auth
  // user's own key is their sign-in and must reach the child.
  const env = withCliRuntimeOnPath(
    command,
    decorateEnv({
      ...applyClaudeEnvPatch(
        withoutInheritedClaudeConfigDir(inheritedEnv, process.platform),
        {},
        {
          stripAuthEnv: auth.stripAuthEnv,
          platform: process.platform
        }
      ),
      ...(overlay ? cloneDefinedEnv(overlay) : {})
    }),
    { platform: process.platform }
  )
  return { command, env }
}

/** A refused account is a situation the person acts on, so the chat names it, not only the log. */
async function prepareClaudeChatProfile(
  profiles: ClaudeProfileRoutingService
): Promise<ClaudeRuntimeAuthPreparation> {
  try {
    return await profiles.prepare()
  } catch (error) {
    if (error instanceof ClaudeProfileSignInRequiredError) {
      throw new AgentSessionPreSpawnError(error, { reason: 'accountSignInRequired' })
    }
    if (error instanceof ClaudeProfileIdentityRefusalError) {
      throw new AgentSessionPreSpawnError(error, { reason: 'accountLoginChanged' })
    }
    throw error
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
    const profiles = getClaudeProfileRoutingAuthority()
    const prepared = profiles ? await prepareClaudeChatProfile(profiles) : undefined
    let launchHome = agentSessionLaunchAccountHome(record).path
    const gate = profiles ? undefined : deps.readManagedAccountGate?.()
    if (gate !== undefined && !structuredClaudeMatchesActiveManagedAccount(gate)) {
      // Unreadable account state names no situation a person can act on, so only the log reads it.
      throw new AgentSessionPreSpawnError(
        'structured Claude is not offered under the active managed Claude account',
        gate && hasWslBoundClaudeAccount(gate) ? { reason: 'managedAccountUnsupported' } : {}
      )
    }
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (
      head?.handle.provider === 'claude' &&
      (identity.providerHandle.kind !== 'claude' ||
        identity.providerHandle.sessionId !== head.handle.sessionId)
    ) {
      throw new Error('claude durable resume identity changed before spawn')
    }
    const providerSessionId =
      head?.handle.provider === 'claude'
        ? head.handle.sessionId
        : claudeSessionIdForOrcaSession(identity.sessionId)
    const continuesChain = head?.handle.provider === 'claude'
    // A start that failed before its first turn wrote no transcript, and `--resume` of an absent
    // one exits; launch that id fresh instead. With a transcript, `--session-id` would collide.
    const resumesTranscript =
      head?.handle.provider === 'claude' &&
      (head.handle.leafUuid !== null ||
        (await (deps.hasTranscript ?? claudeTranscriptExists)({
          providerSessionId,
          claudeConfigDir: record.accountHome.path
        })))
    // `record.launchArgs` is deliberately not read: the configured CLI arguments are a terminal
    // concern, and the permission mode they used to smuggle in is an owned provider option now.
    const permission = claudeStructuredPermissionOptions(
      (await deps.resolvePermissionMode?.()) ?? 'default'
    )
    const { command, env } = await resolveClaudeStructuredInvocation(
      prepared
        ? { ...deps, resolveAuthPolicy: () => ({ stripAuthEnv: prepared.stripAuthEnv }) }
        : deps,
      (base) =>
        // Every structured session speaks orchestration as itself: its injected id and the Orca CLI.
        structuredSessionChildIdentityEnv(record.sessionId, {
          ...base,
          // The turn translator relies on Claude's authoritative idle frame when no result arrives.
          [CLAUDE_SESSION_STATE_EVENTS_ENV]: '1'
        })
    )
    if (profiles && prepared) {
      const accountId = prepared.profileLaunch?.profile?.accountId ?? null
      if ((profiles.resolve().profile?.accountId ?? null) !== accountId) {
        throw new Error('Claude account changed before launch; retry')
      }
      // Why the create resolver: System Default keeps the Claude agent env's own CLAUDE_CONFIG_DIR.
      launchHome = resolveStructuredClaudeAccountHomePath({
        launchEnv: env,
        wslDistro: null,
        getClaudeConfigDirectory: () => prepared.configDir
      })
      if (
        resumesTranscript &&
        !(await (deps.hasTranscript ?? claudeTranscriptExists)({
          providerSessionId,
          claudeConfigDir: launchHome
        }))
      ) {
        throw new Error('Conversation history is not available in the selected Claude profile')
      }
      applyClaudeEnvPatch(env, prepared.envPatch, { stripAuthEnv: prepared.stripAuthEnv })
      await deps.store.transitionHandoff(record.sessionId, (current) => {
        if (current.lease.runtimeFence !== record.lease.runtimeFence) {
          throw new Error('Claude session ownership changed before launch')
        }
        return {
          ...current,
          launchAccountHome: {
            variable: 'CLAUDE_CONFIG_DIR',
            path: launchHome,
            accountId
          }
        }
      })
    }
    return {
      pathToClaudeCodeExecutable: command,
      options: {
        ...CLAUDE_STRUCTURED_BASE_OPTIONS,
        ...permission,
        extraArgs: { ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs, ...permission.extraArgs },
        // Claude owns where a resumed conversation continues; the stored leaf is Orca's bookkeeping.
        ...(resumesTranscript ? { resume: providerSessionId } : { sessionId: providerSessionId })
      },
      cwd: await deps.resolveWorkspacePath(record.location.workspaceId),
      env,
      claudeConfigDir: launchHome,
      providerSessionId,
      resumeLeafUuid:
        resumesTranscript && head?.handle.provider === 'claude' ? head.handle.leafUuid : null,
      resumesTranscript,
      continuesChain
    }
  }
}
