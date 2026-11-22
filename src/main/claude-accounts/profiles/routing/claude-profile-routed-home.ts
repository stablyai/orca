import { lstat } from 'node:fs/promises'
import type { ClaudeProfileRouter } from './claude-profile-router'
import {
  claudeStateFileAsync,
  isSameClaudeLogin,
  readClaudeFolderLoginAsync
} from '../../sign-in/claude-account-folder'
import {
  claudeAccountBindingUnavailable,
  claudeProfileMissing
} from './claude-profile-launch-errors'
import type { ClaudeAccountBinding } from '../../../../shared/agent-accounts/claude/claude-account-binding'

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

/** A project's bound folder; `identity` names it before it exists, `checked` also needs its login. */
export async function claudeBoundHomeAsync(
  router: Pick<ClaudeProfileRouter, 'accountHome' | 'userHome'>,
  binding: ClaudeAccountBinding,
  availability: 'checked' | 'identity' = 'checked'
): Promise<string> {
  const home =
    binding.kind === 'managed' ? router.accountHome(binding.accountId) : binding.configDir
  if (availability === 'identity') {
    return home
  }
  const isFolder = (await lstat(home).catch(() => null))?.isDirectory()
  const login = isFolder
    ? await claudeStateFileAsync(home, router.userHome).then(readClaudeFolderLoginAsync)
    : null
  if (!login) {
    throw claudeAccountBindingUnavailable()
  }
  return home
}
