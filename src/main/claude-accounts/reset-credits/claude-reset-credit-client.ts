import { z } from 'zod'
import type {
  ClaudeResetAccount,
  ClaudeResetCreditOffer,
  ClaudeResetCreditRequest,
  ClaudeResetCreditResult,
  ClaudeResetIdentity
} from '../../../shared/agent-accounts/claude/claude-reset-credit-types'
import { canUseClaudeResetGrant } from '../../../shared/agent-accounts/claude/claude-reset-credit-types'
import type { ClaudeRuntimeAuthPreparation } from '../runtime-auth/runtime-auth-types'
import {
  readClaudeOAuthCredentials,
  resolveClaudeOAuthCredentialReadOptions
} from '../../rate-limits/providers/claude/claude-oauth-credentials'
import {
  claudeOAuthHeaders,
  invalidateClaudeOAuthVersion,
  requestClaudeOAuth
} from '../../rate-limits/providers/claude/claude-oauth-request'
import { mapClaudeResetCredits } from '../../rate-limits/providers/claude/claude-reset-credit-response'
import type { ClaudeResetCreditLedger } from './claude-reset-credit-ledger'

const uuid = z.uuid().refine((value) => value !== '00000000-0000-0000-0000-000000000000')
const profileSchema = z.object({
  account: z.object({ email: z.string().min(1), uuid }),
  organization: z.object({ uuid })
})
const resultSchema = z.object({
  result: z.enum(['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible']),
  grant_id: z.string().optional(),
  reason: z.string().optional(),
  cleared: z.array(z.string()).optional(),
  cooldown_until: z.string().nullable().optional()
})

export class ClaudeResetCreditClient {
  constructor(private readonly ledger: ClaudeResetCreditLedger) {}

  async query(
    account: ClaudeResetAccount,
    auth: ClaudeRuntimeAuthPreparation,
    expectedEmail?: string | null,
    requestId?: string
  ): Promise<ClaudeResetCreditOffer> {
    const headers = await this.headers(auth)
    const { identity, credits } = await this.readOffer(headers, auth)
    if (expectedEmail && identity.email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error(
        'The Claude credentials belong to a different account. Refresh the account list.'
      )
    }
    const pendingRequestId = await this.ledger.reconcile(identity, credits)
    const previousId = requestId
    return {
      account,
      identity,
      credits,
      pendingRequestId,
      previousResult: previousId ? await this.ledger.lookupResult(previousId, identity) : null
    }
  }

  async consume(
    request: ClaudeResetCreditRequest,
    auth: ClaudeRuntimeAuthPreparation
  ): Promise<ClaudeResetCreditResult> {
    const replay = await this.ledger.replay(request)
    if (replay) {
      return replay
    }
    const headers = await this.headers(auth)
    const fresh = await this.readOffer(headers, auth)
    this.requireIdentity(request.identity, fresh.identity)
    const grants = fresh.credits?.grants.filter((grant) => grant.id === request.grantId) ?? []
    const grant = grants.length === 1 ? grants[0] : null
    if (
      !fresh.credits ||
      !grant ||
      !canUseClaudeResetGrant(fresh.credits, grant) ||
      grant.resetsLeft !== request.expectedResetsLeft ||
      JSON.stringify([...grant.clears].sort()) !==
        JSON.stringify([...request.expectedClears].sort())
    ) {
      throw new Error('This Claude reset is no longer available. Refresh the reset cards.')
    }
    await this.ledger.begin(request, grant.resetsLeft)
    let result: ClaudeResetCreditResult = {
      requestId: request.requestId,
      outcome: 'unknown',
      cleared: [],
      cooldownUntil: null,
      verified: false,
      credits: null
    }
    try {
      const response = await requestClaudeOAuth(
        `/api/organizations/${fresh.identity.organizationUuid}/reset_rate_limits`,
        headers,
        {
          body: JSON.stringify({
            program: 'cedar_ember',
            grant_id: grant.id,
            request_id: request.requestId
          })
        }
      )
      const body: unknown = await response.json()
      const parsed = resultSchema.safeParse(body)
      if (
        response.ok &&
        parsed.success &&
        !['stamp_indeterminate', 'reset_unconfirmed'].includes(parsed.data.reason ?? '') &&
        (!parsed.data.grant_id || parsed.data.grant_id === grant.id) &&
        (parsed.data.result !== 'reset' ||
          (parsed.data.grant_id === grant.id && parsed.data.cleared !== undefined))
      ) {
        result = {
          ...result,
          outcome: parsed.data.result,
          cleared: parsed.data.cleared ?? [],
          cooldownUntil:
            parsed.data.cooldown_until && Number.isFinite(Date.parse(parsed.data.cooldown_until))
              ? Date.parse(parsed.data.cooldown_until)
              : null
        }
      }
    } catch {
      // No POST retries: a transport failure can follow a successful provider-side reset.
    }
    await this.ledger.saveResult(request, result)
    try {
      const credits = await this.readCredits(headers, auth)
      const after = credits?.grants.find((candidate) => candidate.id === grant.id)
      result = {
        ...result,
        credits,
        verified:
          result.outcome === 'reset' && after !== undefined && after.resetsLeft < grant.resetsLeft
      }
    } catch {
      // Keep the POST result even if the subsequent read fails.
    }
    await this.ledger.settle(request, result)
    return result
  }

  private async headers(auth: ClaudeRuntimeAuthPreparation): Promise<Record<string, string>> {
    if (auth.usageError) {
      throw new Error(auth.usageError)
    }
    const credentials = await readClaudeOAuthCredentials(
      resolveClaudeOAuthCredentialReadOptions(auth)
    )
    if (!credentials.token) {
      throw new Error('Sign in to this Claude account again before using reset cards.')
    }
    const headers = await claudeOAuthHeaders(credentials.token, auth)
    if (headers['User-Agent'] === 'orca') {
      throw new Error(
        'Could not read the Claude CLI version on this host. Install or update Claude Code, then refresh.'
      )
    }
    return headers
  }

  private async readOffer(headers: Record<string, string>, auth: ClaudeRuntimeAuthPreparation) {
    const response = await requestClaudeOAuth('/api/oauth/profile', headers)
    const body: unknown = await response.json()
    if (!response.ok) {
      throw new Error(`Claude account verification failed (HTTP ${response.status}).`)
    }
    const profile = profileSchema.parse(body)
    const identity: ClaudeResetIdentity = {
      email: profile.account.email,
      accountUuid: profile.account.uuid,
      organizationUuid: profile.organization.uuid
    }
    return { identity, credits: await this.readCredits(headers, auth) }
  }

  private async readCredits(headers: Record<string, string>, auth: ClaudeRuntimeAuthPreparation) {
    const response = await requestClaudeOAuth(
      '/api/oauth/usage?cedar_ember=1&skip_spend=1',
      headers
    )
    const body: unknown = await response.json()
    if (!response.ok) {
      throw new Error(`Claude reset-card query failed (HTTP ${response.status}).`)
    }
    const payload = z.object({ cedar_ember: z.unknown().optional() }).parse(body)
    const credits = mapClaudeResetCredits(payload.cedar_ember)
    if (credits?.ineligibleReason === 'cli_version') {
      invalidateClaudeOAuthVersion(auth)
    }
    return credits
  }

  private requireIdentity(expected: ClaudeResetIdentity, actual: ClaudeResetIdentity): void {
    if (
      expected.accountUuid !== actual.accountUuid ||
      expected.organizationUuid !== actual.organizationUuid ||
      expected.email.toLowerCase() !== actual.email.toLowerCase()
    ) {
      throw new Error(
        'The Claude account or organization changed. Refresh the reset cards before confirming.'
      )
    }
  }
}
