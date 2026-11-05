import {
  supportsSessionAccountUsage,
  type AgentSessionAccountUsage
} from '../../../../shared/agent-session/agent-session-account-usage'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { buildCodexResetCreditExpectedScope } from '../../../../shared/codex-reset-credit-scope'
import { getSystemCodexHomePath } from '../../../codex/configuration/homes/codex-home-paths'
import { getSelectedCodexAccountIdForTarget } from '../../../codex-accounts/runtime-selection'
import {
  isCodexMethodNotFoundError,
  isCodexAppServerUnsupportedError
} from '../../../codex/app-server/codex-app-server-session'
import { CodexUsageApiKeyAuthError } from '../../../rate-limits/codex-rpc-rate-limit-mapper'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'
import { OptionsParams } from './structured-agent-session-schemas'

type UsageOfferSettings = Partial<
  Pick<
    GlobalSettings,
    'codexManagedAccounts' | 'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime'
  >
>

function sessionManagedAccount(
  record: AgentSessionRecord,
  settings: UsageOfferSettings,
  state: RateLimitState | undefined
) {
  const home = normalizeRuntimePathForComparison(
    requireLegacyAgentSessionAccountHome(record.accountHome).path
  )
  // Usage is offered only for native-local chats, so the chat always runs on the host runtime.
  const target = { runtime: 'host' as const, wslDistro: null }
  const account = (settings.codexManagedAccounts ?? []).find(
    (candidate) =>
      (candidate.managedHomeRuntime ?? 'host') === 'host' &&
      normalizeRuntimePathForComparison(candidate.managedHomePath) === home
  )
  const selected =
    account !== undefined &&
    state !== undefined &&
    state.codexTarget.runtime === target.runtime &&
    state.codexTarget.wslDistro === target.wslDistro &&
    getSelectedCodexAccountIdForTarget(
      { ...settings, activeCodexManagedAccountId: settings.activeCodexManagedAccountId ?? null },
      target
    ) === account.id
  return { home, target, account, selected }
}

export function sessionAccountUsageOffer(
  record: AgentSessionRecord,
  settings: UsageOfferSettings,
  state: RateLimitState | undefined
) {
  const { home, target, account, selected } = sessionManagedAccount(record, settings, state)
  const matches = selected && account && state
  const scope = matches
    ? buildCodexResetCreditExpectedScope({ target, account, limits: state.codex })
    : null
  const credits = scope ? state?.codex?.rateLimitResetCredits : undefined
  return {
    account: account
      ? { kind: 'managed' as const, email: account.email }
      : home === normalizeRuntimePathForComparison(getSystemCodexHomePath())
        ? { kind: 'system' as const }
        : null,
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

// A slow host read leaves the card without its reset button rather than holding the usage numbers.
const SNAPSHOT_WAIT_MS = 15_000

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
      let snapshotTimer: ReturnType<typeof setTimeout> | undefined
      try {
        // Capture the adapter read now; usage never enters the conversation's mutation queue.
        const read = host.deps.agents
          .registration(record.provider)
          ?.adapter.readAccountUsage?.(record, abort.signal)
        if (!read) {
          return { status: 'failed' }
        }
        const rateLimits = ctx.runtime.getUsageRateLimits()
        const settings = ctx.runtime.requireStore().getSettings()
        const current = rateLimits?.getState()
        // Before the host's first Codex read the reset offer has nothing to build its scope from;
        // one forced read for the selected account lets this card offer its reset now.
        const snapshot =
          rateLimits &&
          current &&
          current.codex?.status !== 'ok' &&
          sessionManagedAccount(record, settings, current).selected
            ? Promise.race([
                rateLimits.refreshCodexForTarget(current.codexTarget).catch(() => undefined),
                new Promise<undefined>((resolve) => {
                  snapshotTimer = setTimeout(() => resolve(undefined), SNAPSHOT_WAIT_MS)
                })
              ]).then(() => rateLimits.getState())
            : Promise.resolve(current)
        const [result, state] = await Promise.race([
          Promise.all([read, snapshot]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort()
              reject(new Error('Codex usage timed out'))
            }, 40_000)
          })
        ])
        const offer = sessionAccountUsageOffer(record, settings, state)
        return {
          status: 'ok',
          ...offer,
          account: offer.account ?? {
            kind: 'shared',
            ...(result.live && result.account?.email ? { email: result.account.email } : {})
          },
          rateLimits: result.rateLimits
        }
      } catch (error) {
        if (isCodexMethodNotFoundError(error) || isCodexAppServerUnsupportedError(error)) {
          return { status: 'unsupported', reason: 'codexVersion' }
        }
        if (error instanceof CodexUsageApiKeyAuthError) {
          return { status: 'unsupported', reason: 'apiKeyAuth' }
        }
        return { status: 'failed' }
      } finally {
        clearTimeout(timer)
        clearTimeout(snapshotTimer)
      }
    }
  })
]
