import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'

const SelectAccountParams = z.object({
  accountId: z
    .union([z.string().min(1, 'Missing accountId'), z.null()])
    .transform((v) => (v === null ? null : v))
})

const RemoveAccountParams = z.object({
  accountId: z.string().min(1, 'Missing accountId')
})

const AccountsUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

// Why: bridges the desktop ClaudeAccountService / CodexAccountService /
// RateLimitService into the mobile WebSocket RPC. Read + switch + remove
// only — interactive add/re-auth flows spawn `claude login` / `codex login`
// PTYs that need a desktop browser, so they intentionally remain
// desktop-only. See plan in spec doc for issue #1438.
export const ACCOUNT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'accounts.list',
    params: null,
    handler: async (_params, { runtime }) => {
      // Why: ensure the snapshot reflects the latest provider state before
      // returning. Desktop polling pauses when the window is unfocused and
      // inactive-account caches only fill on AccountsPane open, so without
      // this the mobile UI would render stale nulls / zeroes.
      await runtime.refreshAccountsForMobile()
      return runtime.getAccountsSnapshot()
    }
  }),
  defineMethod({
    name: 'accounts.selectClaude',
    params: SelectAccountParams,
    handler: async (params, { runtime }) => runtime.selectClaudeAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.selectCodex',
    params: SelectAccountParams,
    handler: async (params, { runtime }) => runtime.selectCodexAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.removeClaude',
    params: RemoveAccountParams,
    handler: async (params, { runtime }) => runtime.removeClaudeAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.removeCodex',
    params: RemoveAccountParams,
    handler: async (params, { runtime }) => runtime.removeCodexAccount(params.accountId)
  }),
  // Why: streaming counterpart so mobile usage bars refresh in place when the
  // desktop's 5-minute rate-limit poll completes or when the user switches
  // accounts on either side. Mirrors the notifications.subscribe pattern.
  defineStreamingMethod({
    name: 'accounts.subscribe',
    params: null,
    handler: async (_params, { runtime }, emit) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = runtime.onAccountsChanged((snapshot) => {
          emit({ type: 'snapshot', snapshot })
        })

        const subscriptionId = `accounts-${Date.now()}`
        runtime.registerSubscriptionCleanup(subscriptionId, () => {
          unsubscribe()
          emit({ type: 'end' })
          resolve()
        })

        // Why: emit the current snapshot synchronously so the phone has
        // something to render immediately, then kick a forced refresh that
        // will broadcast a fresh snapshot through the listener once each
        // provider fetch completes.
        emit({ type: 'ready', subscriptionId, snapshot: runtime.getAccountsSnapshot() })
        void runtime.refreshAccountsForMobile()
      })
    }
  }),
  defineMethod({
    name: 'accounts.unsubscribe',
    params: AccountsUnsubscribeParams,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
