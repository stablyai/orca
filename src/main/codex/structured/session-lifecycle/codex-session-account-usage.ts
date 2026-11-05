import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { readCodexAccountUsageForHome } from '../../../rate-limits/codex-fetcher'
import {
  mapCodexRpcRateLimits,
  type RpcRateLimitsResponse
} from '../../../rate-limits/codex-rpc-rate-limit-mapper'
import type { CodexAccountUsageRead } from '../../../rate-limits/codex-rpc-rate-limit-probe'
import type { CodexSession } from './codex-structured-session-state'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'

export function readCodexSessionAccountUsage(
  sessions: Map<string, CodexSession>
): NonNullable<StructuredAgentSessionAdapter['readAccountUsage']> {
  return async (record, signal) => {
    const connection = sessions.get(record.sessionId)?.connection
    if (!connection || connection.closed) {
      return readCodexAccountUsageForHome(
        requireLegacyAgentSessionAccountHome(record.accountHome).path,
        signal
      )
    }
    const accountReply = await connection.request('account/read', {}, { timeoutMs: 10_000 })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Codex's account/read response owns the account envelope.
    const { account } = accountReply as Pick<CodexAccountUsageRead, 'account'>
    if (account?.type === 'apiKey') {
      throw new Error('API key authentication requires a ChatGPT account for usage')
    }
    const limits = await connection.request('account/rateLimits/read', {}, { timeoutMs: 10_000 })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing mapper reads Codex's optional rate-limit response fields.
    const rateLimits = mapCodexRpcRateLimits(limits as RpcRateLimitsResponse)
    return { account, rateLimits, live: true }
  }
}
