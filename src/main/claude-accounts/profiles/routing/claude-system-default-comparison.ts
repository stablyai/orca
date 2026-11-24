import { isSameClaudeLogin } from '../../sign-in/claude-account-folder'
import type { ClaudeProfileRouter } from './claude-profile-router'

/** Whether System default runs another login than the selected account; null when none is selected. */
export function claudeSystemDefaultRunsAnotherAccount(
  router: Pick<
    ClaudeProfileRouter,
    'selectedProfile' | 'accountLogin' | 'savedAccount' | 'systemDefaultLogin'
  >
): boolean | null {
  const profile = router.selectedProfile()
  if (!profile) {
    return null
  }
  const selected = router.accountLogin(profile.accountId) ?? router.savedAccount(profile.accountId)
  const systemDefault = router.systemDefaultLogin(5_000)
  return !selected || !systemDefault || !isSameClaudeLogin(selected, systemDefault)
}
