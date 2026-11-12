import { readZcodePlanApiKey } from '../../zcode-plan-api-key-store'
import {
  readZcodeV2PlanCredential,
  localZcodeCredentialHost
} from '../../zcode-v2-plan-credentials'
import type { ZcodePlanSite } from '../../../../shared/zcode-plan-sites'

// Headless zcode app-servers have no account models until their host pushes an entitled account
// snapshot and answers runtime-header asks with real credentials (the desktop host's own job).
// Orca serves both from its own plan key store first — zcode's v2 store is OS-encrypted on
// 3.15+ desktop installs and unreadable headless.

export const ZCODE_PLAN_PROVIDER_IDS: Readonly<Record<ZcodePlanSite, string>> = {
  zai: 'account:zai-individual-coding-plan',
  bigmodel: 'account:bigmodel-individual-coding-plan'
}

export type ZcodeChatCredentials = {
  /** The coding-plan family the key belongs to; the account push entitles exactly it. */
  site: ZcodePlanSite
  apiKey: string
  providerId: string
}

export type ZcodeChatAccountSource = {
  /** The plan site the user connected to Orca, from settings; defaults to the v2 selection. */
  site?: ZcodePlanSite
}

export function zcodePlanProviderId(site: ZcodePlanSite): string {
  return ZCODE_PLAN_PROVIDER_IDS[site]
}

/** The credentials a zcode chat can present, Orca's own plan key first. */
export function resolveZcodeChatCredentials(
  source: ZcodeChatAccountSource = {}
): ZcodeChatCredentials | null {
  const apiKey = readZcodePlanApiKeyOrNull()
  if (apiKey && source.site) {
    return { site: source.site, apiKey, providerId: zcodePlanProviderId(source.site) }
  }
  const v2 = readZcodeV2PlanCredential(localZcodeCredentialHost())
  if (v2.status === 'ok') {
    return {
      site: siteOfBaseUrl(v2.baseUrl),
      apiKey: v2.apiKey,
      providerId: providerIdOfBaseUrl(v2.baseUrl)
    }
  }
  if (apiKey) {
    // A stored key without a named site keeps the mainland default the settings UI uses.
    const site: ZcodePlanSite = source.site ?? 'bigmodel'
    return { site, apiKey, providerId: zcodePlanProviderId(site) }
  }
  return null
}

function readZcodePlanApiKeyOrNull(): string | null {
  try {
    return readZcodePlanApiKey()
  } catch {
    // Undecryptable or absent; the v2 store decides.
    return null
  }
}

function siteOfBaseUrl(baseUrl: string): ZcodePlanSite {
  return baseUrl.includes('z.ai') ? 'zai' : 'bigmodel'
}

function providerIdOfBaseUrl(baseUrl: string): string {
  return zcodePlanProviderId(siteOfBaseUrl(baseUrl))
}
