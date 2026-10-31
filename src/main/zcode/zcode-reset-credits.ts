// The GLM Coding Plan's quota rate-limit resets ("重置卡"): query the available card inventory
// from the same business API host the quota endpoint uses.
//
// Auth contract (mirrors the reference BigModelUsageQuotaProvider): `Authorization` carries the
// zcode JWT, `X-Bigmodel-Authorization` carries the coding-plan MaaS JWT of the active family
// (raw, no Bearer). Both live as plain keys in the v2 credential store Orca already reads.

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import {
  decryptZcodeV2CredentialValue,
  localZcodeCredentialHost,
  type ZcodeCredentialHost
} from './zcode-v2-plan-credentials'

const RESET_BASE_PATH = '/api/v1/coding-plan/reset'
const MAX_CREDENTIAL_STORE_BYTES = 4 * 1024 * 1024

/** The shape ProviderRateLimits.rateLimitResetCredits carries on the wire. The week pool rides
 *  the optional fields — codex's single-flavor consumers read only the five-hour head fields. */
export type ZcodeResetCredits = {
  availableCount: number
  nextExpiresAt: number | null
  credits: { status: string; expiresAt: number; grantedAt: null }[]
  weekAvailableCount?: number
  weekNextExpiresAt?: number | null
}
const REQUEST_TIMEOUT_MS = 15_000

const resetEnvelopeSchema = z.object({
  code: z.number(),
  data: z.unknown().optional()
})

const resetStatusDataSchema = z.object({
  available_five_hour_resets: z
    .array(z.looseObject({ expire_at: z.number().finite().positive() }))
    .default([]),
  available_week_resets: z
    .array(z.looseObject({ expire_at: z.number().finite().positive() }))
    .default([])
})

const resetAccountSchema = z.looseObject({ id: z.string().trim().min(1) })

function resetTimestamp(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value
}

export type ZcodeResetCredentialFacts = {
  /** Stable, irreversible identity of the exact credential pair used by the reset API. */
  accountId: string
  /** The business origin the reset API answers on, e.g. https://open.bigmodel.cn. */
  origin: string
  /** The zcode business JWT (`zcodejwttoken`), sent as `Authorization: Bearer <jwt>`. */
  zcodeJwt: string
  /** The active family's MaaS JWT, sent raw as `X-Bigmodel-Authorization`. */
  codingPlanJwt: string
}

/** Reads the reset auth material from the v2 credential store: the zcode business JWT plus the
 *  active family's MaaS JWT. Null when the store is absent or either JWT is missing. */
export function readZcodeResetCredentialFacts(
  credentialStorePath: string,
  host: ZcodeCredentialHost = localZcodeCredentialHost()
): ZcodeResetCredentialFacts | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      readNodeFileSyncWithinLimit(credentialStorePath, MAX_CREDENTIAL_STORE_BYTES, {
        regularFileOnly: true
      }).buffer.toString('utf8')
    )
  } catch {
    return null
  }
  const store = z
    .looseObject({
      zcodejwttoken: z.string().optional(),
      'oauth:bigmodel:access_token': z.string().optional(),
      'oauth:zai:access_token': z.string().optional(),
      'oauth:bigmodel:user_info': z.string().optional(),
      'oauth:zai:user_info': z.string().optional(),
      'oauth:active_provider': z.string().optional()
    })
    .safeParse(parsed)
  if (!store.success) {
    return null
  }
  try {
    const activeProvider = store.data['oauth:active_provider']
      ? decryptZcodeV2CredentialValue(store.data['oauth:active_provider'], host).trim()
      : ''
    if (activeProvider !== 'zai' && activeProvider !== 'bigmodel') {
      return null
    }
    const family = activeProvider
    const rawCodingPlanJwt =
      family === 'zai'
        ? store.data['oauth:zai:access_token']
        : store.data['oauth:bigmodel:access_token']
    const rawUserInfo =
      family === 'zai' ? store.data['oauth:zai:user_info'] : store.data['oauth:bigmodel:user_info']
    if (!store.data.zcodejwttoken || !rawCodingPlanJwt || !rawUserInfo) {
      return null
    }
    const zcodeJwt = decryptZcodeV2CredentialValue(store.data.zcodejwttoken, host).trim()
    const codingPlanJwt = decryptZcodeV2CredentialValue(rawCodingPlanJwt, host).trim()
    const account = resetAccountSchema.safeParse(
      JSON.parse(decryptZcodeV2CredentialValue(rawUserInfo, host))
    )
    if (!zcodeJwt || !codingPlanJwt || !account.success) {
      return null
    }
    const origin = family === 'zai' ? 'https://api.z.ai' : 'https://open.bigmodel.cn'
    const accountId = createHash('sha256')
      .update(JSON.stringify([family, account.data.id]))
      .digest('base64url')
    return { accountId, origin, zcodeJwt, codingPlanJwt }
  } catch {
    return null
  }
}

export function readZcodeResetAccountId(
  credentialStorePath: string,
  host?: ZcodeCredentialHost
): string | null {
  return readZcodeResetCredentialFacts(credentialStorePath, host)?.accountId ?? null
}

function resetHeaders(facts: ZcodeResetCredentialFacts): Record<string, string> {
  return {
    Authorization: `Bearer ${facts.zcodeJwt}`,
    'X-Bigmodel-Authorization': facts.codingPlanJwt,
    'Bigmodel-Target-Type': 'PERSONAL',
    'content-type': 'application/json'
  }
}

async function readResetEnvelope(
  response: Response
): Promise<{ code: number; data: unknown } | null> {
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return null
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return null
  }
  const envelope = resetEnvelopeSchema.safeParse(payload)
  if (!envelope.success || (envelope.data.code !== 200 && envelope.data.code !== 0)) {
    return null
  }
  return { code: envelope.data.code, data: envelope.data.data }
}

/** The available rate-limit reset inventory: five-hour resets with their expiries. Null when the
 *  credential store or the endpoint cannot answer — presence-only, never a hard failure. */
export async function fetchZcodeResetCredits(options: {
  credentialStorePath: string
  host?: ZcodeCredentialHost
  accountId?: string
  signal?: AbortSignal
}): Promise<ZcodeResetCredits | null> {
  const facts = readZcodeResetCredentialFacts(options.credentialStorePath, options.host)
  if (!facts || (options.accountId && options.accountId !== facts.accountId)) {
    return null
  }
  let response: Response
  try {
    response = await fetch(`${facts.origin}${RESET_BASE_PATH}/status`, {
      headers: resetHeaders(facts),
      signal: abortSignalWithTimeout(options.signal, REQUEST_TIMEOUT_MS)
    })
  } catch {
    return null
  }
  const envelope = await readResetEnvelope(response)
  if (!envelope) {
    return null
  }
  const data = resetStatusDataSchema.safeParse(envelope.data)
  if (!data.success) {
    return null
  }
  const cards = data.data.available_five_hour_resets
    .map((card) => ({ ...card, expire_at: resetTimestamp(card.expire_at) }))
    .sort((a, b) => a.expire_at - b.expire_at)
  const weekCards = data.data.available_week_resets
    .map((card) => ({ ...card, expire_at: resetTimestamp(card.expire_at) }))
    .sort((a, b) => a.expire_at - b.expire_at)
  if (cards.length === 0 && weekCards.length === 0) {
    return null
  }
  return {
    availableCount: cards.length,
    nextExpiresAt: cards[0]?.expire_at ?? null,
    credits: cards.map((card) => ({
      status: 'available',
      expiresAt: card.expire_at,
      grantedAt: null
    })),
    ...(weekCards.length > 0
      ? { weekAvailableCount: weekCards.length, weekNextExpiresAt: weekCards[0].expire_at }
      : {})
  }
}
