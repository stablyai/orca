import { join } from 'node:path'
import type { ClaudeAccountRecipe } from '../../../../shared/agent-session/lifecycle/agent-session-acquired-account'
import { claudeAuthProxyListeningPort } from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-host'
import {
  claudeAuthProxySlotId,
  isForeignClaudeAuthProxyUrl
} from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-url'
import type { ClaudeProfileRouter } from '../../../claude-accounts/claude-profile-router'
import { applyClaudeEnvPatch } from '../../../claude-accounts/environment'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth/runtime-auth-types'
import {
  forgetClaudePaneAccount,
  getClaudePaneAccount,
  recordClaudePaneAccount
} from '../../../claude-accounts/claude-pane-account-registry'
import { AgentSessionPreSpawnError } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { resolveSessionFilePath } from '../../../native-chat/session-file-resolver'
import { resolveStructuredClaudeAccountHomePath } from '../../../runtime/agent-session/environment/structured-agent-account-home'
import { prepareClaudeLaunchAccount } from '../../claude-launch-account'
import {
  applyStructuredClaudeProxySlot,
  prepareStructuredClaudeAccount,
  preparedClaudeProxySlot,
  releasePreparedClaudeSlot,
  selectedClaudeAccountId,
  structuredLaunchAccountId
} from '../../claude-structured-pane-account'
import { structuredClaudeSessionKey } from '../claude-structured-session-key'

export type ClaudeStructuredLaunchSession = {
  sessionId: string
  providerSessionId: string
  workspaceId?: string
}

/** Follow the current account selection and pin its environment for this launch. */
export async function resolveClaudeStructuredLaunchHome(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string
): Promise<string> {
  if (!router) {
    return recordHome
  }
  dropForeignProxyUrl(env)
  const recipe = await prepareClaudeLaunchAccount(router, env, recordHome)
  // Naming launches never commit a pane, so a slot minted into their env is released.
  releasePreparedClaudeSlot(
    { configDir: recipe.home, envPatch: {}, provenance: 'system' },
    preparedClaudeProxySlot({ ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL })
  )
  return recipe.home
}

function recipeFor(
  preparation: ClaudeRuntimeAuthPreparation,
  home: string,
  env: Record<string, string>
): ClaudeAccountRecipe {
  return preparation.provenance.startsWith('profile:')
    ? { route: 'managed', accountId: preparation.provenance.slice('profile:'.length), home }
    : { route: 'system', home, configDir: env.CLAUDE_CONFIG_DIR ?? null }
}

/**
 * The account a chat session launches on: the one it already ran on, else the pool's pick, else
 * the selection. The pane registry records the session so the mover, the proxy and the tab chip
 * see it like a terminal pane.
 */
export async function prepareStructuredClaudeLaunchAccount(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string,
  session: ClaudeStructuredLaunchSession
): Promise<ClaudeAccountRecipe> {
  if (!router) {
    return prepareClaudeLaunchAccount(router, env, recordHome)
  }
  const userDir = env.CLAUDE_CONFIG_DIR?.trim() || undefined
  dropForeignProxyUrl(env)
  const userPinnedUrl = Boolean(
    env.ANTHROPIC_BASE_URL && claudeAuthProxySlotId(env.ANTHROPIC_BASE_URL) === null
  )
  const sessionKey = structuredClaudeSessionKey(session.sessionId)
  const existing = getClaudePaneAccount(sessionKey)
  const chosen = await prepareStructuredClaudeAccount({
    router,
    existing,
    providerSessionId: session.providerSessionId,
    // A folder the user set is the launch. The pool still chooses when only the base URL is pinned.
    allowPool: !userDir
  })
  const launchHome = await pinClaudeLaunchHome(router, env, chosen.preparation, userDir)
  const recipe = recipeFor(chosen.preparation, launchHome, env)
  const proxySlot = applyStructuredClaudeProxySlot({
    env,
    preparation: chosen.preparation,
    existing,
    reuseRecordedSlot: chosen.reuseRecordedSlot && !userPinnedUrl,
    userPinnedUrl
  })
  const accountId = structuredLaunchAccountId(
    chosen.preparation.provenance,
    selectedClaudeAccountId(router)
  )
  if (!accountId) {
    if (proxySlot) {
      releasePreparedClaudeSlot(chosen.preparation)
    }
    forgetClaudePaneAccount(sessionKey)
    return recipe
  }
  const recorded = chosen.keepRecordedAccount ? existing : null
  const billed = recorded ? (recorded.assignedAccountId ?? recorded.accountId) : accountId
  recordClaudePaneAccount({
    ptyId: sessionKey,
    paneKey: sessionKey,
    surface: 'chat',
    launchSelectionId: selectedClaudeAccountId(router),
    accountId: recorded ? recorded.accountId : accountId,
    configDir: launchHome,
    launchedAt: recorded?.launchedAt ?? Date.now(),
    pinned: Boolean(userDir) || userPinnedUrl,
    source: chosen.pooled ? 'pool' : recorded ? recorded.source : 'spawn',
    providerSessionId: session.providerSessionId,
    ...(session.workspaceId || recorded?.worktreeId
      ? { worktreeId: session.workspaceId ?? recorded?.worktreeId }
      : {}),
    ...(proxySlot || chosen.pooled || recorded?.assignedAccountId
      ? {
          ...(proxySlot ? { proxySlot } : {}),
          assignedAccountId: billed
        }
      : {})
  })
  return recipe
}

function dropForeignProxyUrl(env: Record<string, string>): void {
  const url = env.ANTHROPIC_BASE_URL
  if (url && isForeignClaudeAuthProxyUrl(url, claudeAuthProxyListeningPort())) {
    delete env.ANTHROPIC_BASE_URL
  }
}

async function pinClaudeLaunchHome(
  router: ClaudeProfileRouter,
  env: Record<string, string>,
  preparation: ClaudeRuntimeAuthPreparation,
  userDir: string | undefined
): Promise<string> {
  // Read before patching: System default preserves the launch environment's CLAUDE_CONFIG_DIR.
  const launchHome =
    preparation.provenance === 'system'
      ? await resolveStructuredClaudeAccountHomePath({
          launchEnv: env,
          wslDistro: null,
          getClaudeConfigDirectory: () => router.systemDefaultHome()
        })
      : preparation.configDir
  applyClaudeEnvPatch(env, preparation.envPatch)
  if (userDir) {
    env.CLAUDE_CONFIG_DIR = userDir
    return userDir
  }
  return launchHome
}

async function claudeTranscriptExists(input: {
  providerSessionId: string
  claudeConfigDir: string
  cwd?: string
}): Promise<boolean> {
  const path = await resolveSessionFilePath('claude', input.providerSessionId, {
    claudeProjectsDir: join(input.claudeConfigDir, 'projects'),
    cwd: input.cwd
  })
  return path !== null
}

/** A stored leaf implies resume; refuse known history in another account instead of starting fresh. */
export async function claudeLaunchResumesTranscript(input: {
  router: ClaudeProfileRouter | undefined
  leafUuid: string | null
  providerSessionId: string
  claudeConfigDir: string
  recordHome: string
  /** The launch cwd; Claude keeps its transcript in this folder's project bucket. */
  cwd?: string
  hasTranscript?: typeof claudeTranscriptExists
}): Promise<boolean> {
  const { router, providerSessionId, claudeConfigDir, cwd } = input
  if (!router && input.leafUuid !== null) {
    return true
  }
  const hasTranscript = input.hasTranscript ?? claudeTranscriptExists
  if (await hasTranscript({ providerSessionId, claudeConfigDir, cwd })) {
    return true
  }
  if (input.leafUuid === null) {
    return false
  }
  const otherHomes = router
    ? [input.recordHome, ...router.accountHomes(), router.systemDefaultHome()]
    : []
  for (const home of otherHomes.filter((home) => home !== claudeConfigDir)) {
    if (await hasTranscript({ providerSessionId, claudeConfigDir: home, cwd })) {
      throw new AgentSessionPreSpawnError(
        new Error('claude transcript is not in the selected account'),
        { reason: 'historyInOtherAccount' }
      )
    }
  }
  // A stored leaf still requires resume when its transcript folder is no longer known.
  return true
}
