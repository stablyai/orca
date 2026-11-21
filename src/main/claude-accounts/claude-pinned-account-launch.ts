import { access, lstat } from 'node:fs/promises'
import { CLAUDE_INJECTED_CONFIG_DIR_ENV } from '../../shared/agent-accounts/claude/claude-profile-routing'
import { claudeProfileSetupFailed } from './profiles/routing/claude-profile-launch-errors'
import { claudeProfileMarkerPath, describeClaudeProfile } from './profiles/claude-profile-paths'
import type { ClaudeProfileRouter } from './profiles/routing/claude-profile-router'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

/**
 * A `--account` launch on an account that is not the selected one: Claude runs from that account's
 * folder with no pointer, so a later switch never moves it. While the account has no login of its
 * own, System default runs it, as it would the selected account.
 */
export async function prepareClaudePinnedAccountLaunch(
  router: ClaudeProfileRouter,
  dataRoot: string,
  accountId: string
): Promise<ClaudeRuntimeAuthPreparation> {
  // Why wait only without the account's own login: whether System default covers it depends on the login shell's env.
  if (!router.accountLogin(accountId)) {
    await router.envReady
  }
  const pinned = {
    runtime: 'host' as const,
    wslDistro: null,
    wslLinuxConfigDir: null,
    pinnedAccountId: accountId,
    provenance: `profile:${accountId}:pinned`
  }
  if (router.coveredBySystemDefault(accountId)) {
    // Why no CLAUDE_CONFIG_DIR: naming System default's folder moves Claude to another Keychain item.
    return { ...pinned, configDir: router.systemDefaultHome(), envPatch: {} }
  }
  const profile = describeClaudeProfile(dataRoot, accountId, {
    executionHostId: 'local',
    runtime: 'host'
  })
  const [homePresent, markerPresent] = await Promise.all([
    lstat(profile.home).then(
      (info) => info.isDirectory(),
      () => false
    ),
    access(claudeProfileMarkerPath(profile)).then(
      () => true,
      () => false
    )
  ])
  if (!homePresent || !markerPresent) {
    await router.prepareAccount(accountId).catch(() => {
      throw claudeProfileSetupFailed()
    })
  }
  return {
    ...pinned,
    configDir: profile.home,
    envPatch: { CLAUDE_CONFIG_DIR: profile.home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: profile.home }
  }
}
