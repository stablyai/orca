import { getClaudeProfileRouter } from '../profiles/routing/claude-profile-installed-router'
import {
  readClaudeOAuthCredentials,
  resolveClaudeOAuthCredentialReadOptions
} from '../../rate-limits/providers/claude/claude-oauth-credentials'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-types'

/** Whether the login a host Claude start would run on is there, read as the usage meter reads it. */
export async function claudeLaunchAccountHoldsLogin(): Promise<boolean> {
  const router = getClaudeProfileRouter()
  // Without a router (a host the desktop pushes accounts to), the launch account isn't knowable here.
  if (!router) {
    return false
  }
  let preparation: ClaudeRuntimeAuthPreparation
  try {
    preparation = router.preparation()
  } catch {
    // The selected account's folder is missing: nothing can start until it is set up again.
    return false
  }
  const login = await readClaudeOAuthCredentials(
    resolveClaudeOAuthCredentialReadOptions(preparation)
  )
  return Boolean(login.token || login.hasRefreshableCredentials)
}
