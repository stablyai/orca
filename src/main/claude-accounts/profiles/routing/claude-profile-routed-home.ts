import { lstat } from 'node:fs/promises'
import type { ClaudeProfileRouter } from './claude-profile-router'
import {
  claudeStateFileAsync,
  isSameClaudeLogin,
  readClaudeFolderLoginAsync
} from '../../sign-in/claude-account-folder'
import { claudeProfileMissing } from './claude-profile-launch-errors'

/** `routedHome` without blocking main: chat reads run once per options read and send. `profile` defaults to the selection. */
export async function claudeRoutedHomeAsync(
  router: Pick<
    ClaudeProfileRouter,
    'selectedProfile' | 'savedAccount' | 'userConfigDir' | 'userHome'
  >,
  availability: 'checked' | 'identity' = 'checked',
  profile = router.selectedProfile()
): Promise<string | null> {
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
