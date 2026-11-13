import { createHash } from 'node:crypto'
import { readClaudeSettingsEffort } from './launch/claude-structured-session-options'
import type { AgentSessionAdvisoryReceipt } from '../../../shared/agent-session/agent-session-advisory-receipt'

export function readClaudeAdvisoryBinding(
  input: unknown
): AgentSessionAdvisoryReceipt['execution']['binding'] {
  const raw = input && typeof input === 'object' ? input : null
  const account =
    raw && 'account' in raw && raw.account && typeof raw.account === 'object' ? raw.account : null
  const settings = raw && 'settings' in raw ? raw.settings : null
  const applied =
    settings &&
    typeof settings === 'object' &&
    'applied' in settings &&
    settings.applied &&
    typeof settings.applied === 'object'
      ? settings.applied
      : null
  if (
    !account ||
    !('email' in account) ||
    typeof account.email !== 'string' ||
    !account.email.trim() ||
    !('organization' in account) ||
    typeof account.organization !== 'string' ||
    !('apiProvider' in account) ||
    account.apiProvider !== 'firstParty' ||
    !('apiKeySource' in account) ||
    account.apiKeySource !== 'none' ||
    !('tokenSource' in account) ||
    (account.tokenSource !== 'oauth' && account.tokenSource !== 'claude.ai') ||
    !('subscriptionType' in account) ||
    (account.subscriptionType !== 'pro' && account.subscriptionType !== 'max') ||
    !applied ||
    !('model' in applied) ||
    typeof applied.model !== 'string' ||
    !applied.model.trim()
  ) {
    return null
  }
  const effort = readClaudeSettingsEffort(settings)
  if (!effort) {
    return null
  }
  return {
    accountFingerprint: `claude:${createHash('sha256')
      .update(JSON.stringify([account.email.trim().toLowerCase(), account.organization.trim()]))
      .digest('hex')}`,
    plan: account.subscriptionType,
    model: applied.model,
    effort
  }
}
