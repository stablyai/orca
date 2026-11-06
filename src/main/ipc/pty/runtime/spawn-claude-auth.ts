import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV
} from '../../../../shared/claude-profile-routing'
import { claudeAuthProxyListeningPort } from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-host'
import { noteUserAnthropicBaseUrl } from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-note'
import { claudePoolAccountForLaunch } from '../../../claude-accounts/claude-account-pool-launch'
import { releaseSupersededOwnProxySlot } from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-slot-env'
import {
  claudeAuthProxySlotId,
  isForeignClaudeAuthProxyUrl
} from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-url'
import { getClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth-service'
import type { RuntimePtySpawnState } from './spawn-state'

/**
 * Why: a session-mover resume names the account it moves to. A hand restart of a session the proxy
 * already moved relaunches on that billed account. Every other Orca-made launch runs on the
 * selected account, or on the pool's choice when the pool is on.
 */
export async function resolveRuntimeClaudeAuth(
  ctx: Pick<RuntimePtySpawnState, 'codexSelectionTarget'> & {
    args: Pick<RuntimePtySpawnState['args'], 'claudeAccountId' | 'resumeProviderSession'>
    deps: Pick<RuntimePtySpawnState['deps'], 'prepareClaudeAuth'>
  }
): Promise<ClaudeRuntimeAuthPreparation | null> {
  const accountId = ctx.args.claudeAccountId
  if (accountId !== undefined) {
    const router = getClaudeProfileRouter()
    if (!router) {
      throw new Error('claude_account_router_unavailable')
    }
    return router.prepareLaunchFor(accountId)
  }
  const sessionId = ctx.args.resumeProviderSession?.id
  // Optional: test doubles of the router only implement prepareLaunchFor.
  const assigned = sessionId
    ? getClaudeProfileRouter()?.assignedAccountForResume?.(sessionId)
    : null
  if (assigned) {
    const router = getClaudeProfileRouter()
    if (!router) {
      throw new Error('claude_account_router_unavailable')
    }
    return router.prepareLaunchFor(assigned)
  }
  const pooled = claudePoolAccountForLaunch(ctx.codexSelectionTarget)
  if (pooled?.named) {
    const router = getClaudeProfileRouter()
    if (router) {
      try {
        const preparation = await router.prepareLaunchFor(pooled.accountId)
        return { ...preparation, pooled: true }
      } catch (error) {
        // A missing folder or a WSL account cannot take a host launch env. The selected account still launches.
        console.warn(
          '[claude-account-pool] Could not launch the pooled account; using the selected account:',
          error
        )
      }
    }
  }
  const selected = ctx.deps.prepareClaudeAuth
    ? await ctx.deps.prepareClaudeAuth(ctx.codexSelectionTarget)
    : null
  // A named choice that failed to prepare is the selected account, so it is not recorded as pooled.
  if (!selected || !pooled || pooled.named) {
    return selected
  }
  return { ...selected, pooled: true }
}

/** An explicit account, or any pool choice, must not keep the selected account's shell pointer. */
export function claudeLaunchPinsAccount(
  auth: ClaudeRuntimeAuthPreparation | null,
  claudeAccountId: string | undefined
): boolean {
  return claudeAccountId !== undefined || auth?.pooled === true
}

/**
 * Why strip: preflight merged the SELECTED account's pointer into `args.env`
 * (`withClaudeProfileTerminalEnv`); a spread cannot remove it, and any pointer makes the pane's
 * `claude` shell function re-route to the selected account (`src/shared/claude-shell-function.ts`).
 * A pinned launch starts without it and carries only that account's `CLAUDE_CONFIG_DIR`.
 * `ORCA_CLAUDE_USER_CONFIG_DIR` stays: it names the user's own dir. Never mutates the caller's env.
 */
export function applyRuntimeClaudeAuthEnv(
  env: Record<string, string> | undefined,
  auth: ClaudeRuntimeAuthPreparation | null,
  pinnedToAccount: boolean
): Record<string, string> | undefined {
  if (!auth) {
    return env
  }
  const base: Record<string, string> = { ...env }
  if (pinnedToAccount) {
    delete base[CLAUDE_PROFILE_POINTER_ENV]
    delete base[CLAUDE_INJECTED_CONFIG_DIR_ENV]
    delete base.CLAUDE_CONFIG_DIR
  }
  const patch = { ...auth.envPatch }
  const baseUrl = base.ANTHROPIC_BASE_URL
  // A desktop loopback slot is not a user API host. This process's terminal slot loses to the launch patch.
  if (baseUrl && isForeignClaudeAuthProxyUrl(baseUrl, claudeAuthProxyListeningPort())) {
    delete base.ANTHROPIC_BASE_URL
  } else if (releaseSupersededOwnProxySlot(baseUrl, patch.ANTHROPIC_BASE_URL)) {
    delete base.ANTHROPIC_BASE_URL
  } else if (baseUrl && patch.ANTHROPIC_BASE_URL && claudeAuthProxySlotId(baseUrl) === null) {
    delete patch.ANTHROPIC_BASE_URL
    noteUserAnthropicBaseUrl()
  }
  return { ...base, ...patch }
}
