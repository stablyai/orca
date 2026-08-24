import { ipcMain } from 'electron'
import {
  clearCustomProviderToken,
  hasCustomProviderToken,
  resolveCustomProviderToken,
  saveCustomProviderToken
} from '../custom-providers/custom-provider-token-store'
import { CustomProviderAccount as CustomProviderAccountSchema } from '../custom-providers/custom-provider-account-schema'
import { fetchCustomProviderUsage } from '../rate-limits/custom-provider-fetcher'
import type {
  CustomProviderAccount,
  CustomProviderUsageResult
} from '../../shared/custom-provider-types'
import type { RateLimitService } from '../rate-limits/service'

export type CustomProviderTokenStatus = {
  configured: boolean
}

// Why: fire-and-forget — the save/clear call returns immediately; the refresh
// runs in the background, same pattern as minimax-credentials.ts.
function refreshAfterTokenChange(
  rateLimits: RateLimitService | null,
  action: 'save' | 'clear'
): void {
  void rateLimits?.refresh().catch((error: unknown) => {
    console.error(`[custom-providers] failed to trigger rate-limit refresh after ${action}:`, error)
  })
}

function assertString(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(message)
  }
}

export function registerCustomProviderAccountHandlers(rateLimits: RateLimitService | null): void {
  ipcMain.handle('customProviderAccounts:getTokenStatus', (_event, accountId: string) => {
    assertString(accountId, 'accountId must be a string')
    return { configured: hasCustomProviderToken(accountId) } satisfies CustomProviderTokenStatus
  })

  ipcMain.handle(
    'customProviderAccounts:saveToken',
    (_event, args: { accountId: string; token: string }) => {
      assertString(args?.accountId, 'accountId must be a string')
      assertString(args?.token, 'token must be a string')
      saveCustomProviderToken(args.accountId, args.token)
      refreshAfterTokenChange(rateLimits, 'save')
      return {
        configured: hasCustomProviderToken(args.accountId)
      } satisfies CustomProviderTokenStatus
    }
  )

  ipcMain.handle('customProviderAccounts:clearToken', (_event, accountId: string) => {
    assertString(accountId, 'accountId must be a string')
    clearCustomProviderToken(accountId)
    refreshAfterTokenChange(rateLimits, 'clear')
    return { configured: hasCustomProviderToken(accountId) } satisfies CustomProviderTokenStatus
  })

  // Why: the "Test & Preview" step (mandatory before Save per usability review)
  // must run against the UNSAVED draft — no persistence, no rate-limit
  // invalidation, just one live fetch so the user can verify before committing.
  // Why: this is a renderer-facing IPC boundary — validate the FULL account
  // shape (including the https:// requirement) with the same schema used for
  // persisted accounts, rather than trusting an untyped `account` object. A
  // compromised or buggy renderer could otherwise pass an http:// URL or a
  // malformed shape and still trigger a real fetch with a resolved secret.
  ipcMain.handle(
    'customProviderAccounts:testDraft',
    (
      _event,
      args: { account: CustomProviderAccount; token: string }
    ): Promise<CustomProviderUsageResult> => {
      const account = CustomProviderAccountSchema.parse(args?.account)
      assertString(args.token, 'token must be a string')
      const token = resolveCustomProviderToken(account, args.token.trim() || null)
      return fetchCustomProviderUsage(account, token)
    }
  )
}
