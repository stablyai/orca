import { lstat } from 'node:fs/promises'
import type { ClaudeProfileRouter } from './claude-profile-router'
import {
  claudeStateFileAsync,
  isSameClaudeLogin,
  readClaudeFolderLoginAsync
} from './claude-account-folder'
import { claudeProfileMissing } from './claude-profile-launch-errors'

/** `routedHome` without blocking main: chat reads run once per options read and send. */
export async function claudeRoutedHomeAsync(
  router: Pick<
    ClaudeProfileRouter,
    'selectedProfile' | 'savedAccount' | 'userConfigDir' | 'userHome'
  >,
  availability: 'checked' | 'identity' = 'checked'
): Promise<string | null> {
  const profile = router.selectedProfile()
  if (!profile) {
    return null
  }
  const login = (configDir: string | undefined) =>
    claudeStateFileAsync(configDir, router.userHome).then(readClaudeFolderLoginAsync)
  if (!(await login(profile.home))) {
    // Reuse a matching System default login until the account signs in separately.
    const saved = router.savedAccount(profile.accountId)
    const systemDefault = await login(router.userConfigDir())
    if (saved && systemDefault && isSameClaudeLogin(saved, systemDefault)) {
      return null
    }
  }
  if (availability === 'checked' && !(await lstat(profile.home).catch(() => null))?.isDirectory()) {
    throw claudeProfileMissing()
  }
  return profile.home
}
