import type {
  CursorAccountStatus,
  GrokAccountStatus
} from '../../shared/agent-usage/rate-limits/rate-limit-types'
import type { MiniMaxCredentialsStatus } from '../../shared/minimax-credential-types'
import type { ZcodePlanCredentialsStatus } from '../../shared/agent-accounts/usage-credentials/zcode-plan-sites'
import {
  clearMiniMaxSessionCookie,
  getMiniMaxSessionCookieProtection,
  hasMiniMaxSessionCookie,
  saveMiniMaxSessionCookie
} from '../minimax/minimax-cookie-store'
import {
  clearMiniMaxApiKey,
  getMiniMaxApiKeyProtection,
  hasMiniMaxApiKey,
  saveMiniMaxApiKey
} from '../minimax/minimax-api-key-store'
import { clearMiniMaxSessionCookieJar } from '../rate-limits/providers/minimax/minimax-request-context'
import {
  clearZcodePlanApiKey,
  getZcodePlanApiKeyProtection,
  hasZcodePlanApiKey,
  saveZcodePlanApiKey
} from '../zcode/zcode-plan-api-key-store'
import {
  clearOpenCodeGoApiKey,
  hasOpenCodeGoApiKey,
  saveOpenCodeGoApiKey
} from '../opencode/accounts/opencode-go-api-key-store'
import { getCursorAccountStatus } from '../cursor-accounts/status'
import { getGrokAccountStatus } from '../grok-accounts/status'
import { hasZcodeCliPlanCredentials } from '../rate-limits/providers/zcode/zcode-usage-credentials'
import { refreshAfterCredentialChange } from '../ipc/accounts/credential-change-rate-limit-refresh'
import type { RateLimitService } from '../rate-limits/service/rate-limit-service'

export class RuntimeCredentialController {
  constructor(private readonly getRateLimits: () => RateLimitService) {}

  getMiniMaxStatus(): MiniMaxCredentialsStatus {
    const cookieConfigured = hasMiniMaxSessionCookie()
    const apiKeyConfigured = hasMiniMaxApiKey()
    return {
      configured: cookieConfigured || apiKeyConfigured,
      cookieConfigured,
      apiKeyConfigured,
      cookieProtection: cookieConfigured ? getMiniMaxSessionCookieProtection() : null,
      apiKeyProtection: apiKeyConfigured ? getMiniMaxApiKeyProtection() : null
    }
  }

  saveMiniMaxCookie(cookie: string): MiniMaxCredentialsStatus {
    saveMiniMaxSessionCookie(cookie)
    this.refreshMiniMax('save')
    return this.getMiniMaxStatus()
  }

  async clearMiniMaxCookie(): Promise<MiniMaxCredentialsStatus> {
    clearMiniMaxSessionCookie()
    try {
      await clearMiniMaxSessionCookieJar()
    } catch (error) {
      console.error('[minimax] failed to clear session cookie jar after credential clear:', error)
    }
    this.refreshMiniMax('clear')
    return this.getMiniMaxStatus()
  }

  saveMiniMaxApiKey(key: string): MiniMaxCredentialsStatus {
    saveMiniMaxApiKey(key)
    this.refreshMiniMax('save')
    return this.getMiniMaxStatus()
  }

  clearMiniMaxApiKey(): MiniMaxCredentialsStatus {
    clearMiniMaxApiKey()
    this.refreshMiniMax('clear')
    return this.getMiniMaxStatus()
  }

  getZcodePlanStatus(): ZcodePlanCredentialsStatus {
    return {
      apiKeyConfigured: hasZcodePlanApiKey(),
      zcodeCliConfigured: hasZcodeCliPlanCredentials(),
      apiKeyProtection: getZcodePlanApiKeyProtection()
    }
  }

  saveZcodePlanApiKey(key: string): ZcodePlanCredentialsStatus {
    saveZcodePlanApiKey(key)
    this.refreshZcode('save')
    return this.getZcodePlanStatus()
  }

  clearZcodePlanApiKey(): ZcodePlanCredentialsStatus {
    clearZcodePlanApiKey()
    this.refreshZcode('clear')
    return this.getZcodePlanStatus()
  }

  getOpenCodeGoStatus(): { apiKeyConfigured: boolean } {
    return { apiKeyConfigured: hasOpenCodeGoApiKey() }
  }

  saveOpenCodeGoApiKey(key: string): { apiKeyConfigured: boolean } {
    saveOpenCodeGoApiKey(key)
    this.refreshOpenCodeGo('save', false)
    return this.getOpenCodeGoStatus()
  }

  clearOpenCodeGoApiKey(): { apiKeyConfigured: boolean } {
    clearOpenCodeGoApiKey()
    this.refreshOpenCodeGo('clear', true)
    return this.getOpenCodeGoStatus()
  }

  getCursorStatus(): Promise<CursorAccountStatus> {
    return getCursorAccountStatus()
  }

  getGrokStatus(): GrokAccountStatus {
    return getGrokAccountStatus()
  }

  private refreshMiniMax(action: 'save' | 'clear'): void {
    refreshAfterCredentialChange(
      this.getRateLimits(),
      (service) => service.invalidateMiniMaxCredentialState(),
      `[minimax] failed to trigger rate-limit refresh after ${action}:`
    )
  }

  private refreshZcode(action: 'save' | 'clear'): void {
    refreshAfterCredentialChange(
      this.getRateLimits(),
      (service) => service.invalidateZcodeCredentialState(),
      `[zcode] failed to trigger rate-limit refresh after ${action}:`
    )
  }

  private refreshOpenCodeGo(action: 'save' | 'clear', apiKeyCleared: boolean): void {
    refreshAfterCredentialChange(
      this.getRateLimits(),
      (service) => service.invalidateOpenCodeGoCredentialState({ apiKeyCleared }),
      `[opencode-go] failed to refresh usage after a credential change (${action}):`
    )
  }
}
