import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionAccountUsage } from '../../../../shared/agent-session/agent-session-account-usage'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { isNativeLocalLocation } from '../../../../shared/execution-host'
import { buildCodexResetCreditExpectedScope } from '../../../../shared/codex-reset-credit-scope'
import { getSelectedCodexAccountIdForTarget } from '../../../codex-accounts/runtime-selection'
import {
  isCodexMethodNotFoundError,
  isCodexAppServerUnsupportedError
} from '../../../codex/app-server/codex-app-server-session'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'
import { OptionsParams } from './structured-agent-session-schemas'

export function supportsSessionAccountUsage(
  record: AgentSessionRecord | undefined | null
): boolean {
  return record?.provider === 'codex' && isNativeLocalLocation(record.location)
}

export function sessionAccountUsageOffer(
  record: AgentSessionRecord,
  settings: Partial<
    Pick<
      GlobalSettings,
      | 'codexManagedAccounts'
      | 'activeCodexManagedAccountId'
      | 'activeCodexManagedAccountIdsByRuntime'
    >
  >,
  state: RateLimitState | undefined
) {
  const home = normalizeRuntimePathForComparison(
    requireLegacyAgentSessionAccountHome(record.accountHome).path
  )
  const target = {
    runtime: record.location.wslDistro ? ('wsl' as const) : ('host' as const),
    wslDistro: record.location.wslDistro
  }
  const account = (settings.codexManagedAccounts ?? []).find(
    (candidate) =>
      (candidate.managedHomeRuntime ?? 'host') === target.runtime &&
      (candidate.wslDistro ?? null) === target.wslDistro &&
      [
        candidate.managedHomePath,
        ...(target.runtime === 'wsl' ? [candidate.wslLinuxHomePath] : [])
      ].some((path) => path && normalizeRuntimePathForComparison(path) === home)
  )
  const matches =
    account &&
    state &&
    state.codexTarget.runtime === target.runtime &&
    state.codexTarget.wslDistro === target.wslDistro &&
    getSelectedCodexAccountIdForTarget(
      { ...settings, activeCodexManagedAccountId: settings.activeCodexManagedAccountId ?? null },
      target
    ) === account.id
  const scope = matches
    ? buildCodexResetCreditExpectedScope({ target, account, limits: state.codex })
    : null
  const credits = scope ? state?.codex?.rateLimitResetCredits : undefined
  return {
    accountLabel:
      account?.email ??
      (home === normalizeRuntimePathForComparison(join(homedir(), '.codex'))
        ? 'System default'
        : null),
    ...(scope && credits
      ? {
          reset: {
            available: credits.availableCount,
            expiresAt: credits.nextExpiresAt,
            expectedScope: scope
          }
        }
      : {})
  }
}

export const STRUCTURED_AGENT_SESSION_ACCOUNT_USAGE_METHODS = [
  defineMethod({
    name: 'agentSession.accountUsage',
    permission: 'workspace',
    params: OptionsParams,
    handler: async ({ sessionId }, ctx): Promise<AgentSessionAccountUsage> => {
      const host = await requireInstalledStructuredHost(ctx, sessionId)
      const record = host.deps.store.getRecord(sessionId)
      if (!record || !supportsSessionAccountUsage(record)) {
        return { status: 'failed' }
      }
      const abort = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // Capture the adapter read now; usage never enters the conversation's mutation queue.
        const read = host.deps.agents
          .registration(record.provider)
          ?.adapter.readAccountUsage?.(record, abort.signal)
        if (!read) {
          return { status: 'failed' }
        }
        const result = await Promise.race([
          read,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort()
              reject(new Error('Codex usage timed out'))
            }, 20_000)
          })
        ])
        const offer = sessionAccountUsageOffer(
          record,
          ctx.runtime.requireStore().getSettings(),
          ctx.runtime.getUsageRateLimits()?.getState()
        )
        return {
          status: 'ok',
          ...offer,
          accountLabel:
            offer.accountLabel ??
            (result.live ? result.account?.email : null) ??
            'Current shared account',
          rateLimits: result.rateLimits
        }
      } catch (error) {
        if (isCodexMethodNotFoundError(error) || isCodexAppServerUnsupportedError(error)) {
          return { status: 'unsupported', reason: 'codexVersion' }
        }
        const message =
          error instanceof Error
            ? error.message
            : typeof error === 'object' && error !== null && 'message' in error
              ? String(error.message)
              : ''
        if (
          /api.?key|chatgpt.*(only|required)|requires.*chatgpt|only available.*chatgpt/i.test(
            message
          )
        ) {
          return { status: 'unsupported', reason: 'apiKeyAuth' }
        }
        return { status: 'failed' }
      } finally {
        clearTimeout(timer)
      }
    }
  })
]
