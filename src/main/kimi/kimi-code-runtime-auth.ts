import { createHash } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'

const DEFAULT_OAUTH_HOST = 'https://auth.kimi.com'
const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1'

export type KimiCodeRuntimeAuth = {
  /** File stem under `<kimi home>/credentials/`. */
  tokenName: string
  usageUrl: string
}

const KimiManagedProviderSchema = z.object({
  base_url: z.string().optional(),
  oauth: z.object({ oauth_host: z.string().optional() }).optional()
})

type KimiManagedProviderConfig = z.infer<typeof KimiManagedProviderSchema>

const KimiConfigSchema = z.object({
  providers: z.object({ 'managed:kimi-code': KimiManagedProviderSchema.optional() }).optional()
})

function readManagedProviderConfig(configToml: string): KimiManagedProviderConfig | undefined {
  try {
    const parsed = KimiConfigSchema.safeParse(parseToml(configToml))
    return parsed.success ? parsed.data.providers?.['managed:kimi-code'] : undefined
  } catch {
    return undefined
  }
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Mirrors Kimi Code 2.x resolveKimiCodeRuntimeAuth + resolveKimiCodeOAuthKey +
 * managedUsageUrl (@moonshot-ai/kimi-code dist/main.mjs): the token slot is derived
 * from the effective (oauthHost, baseUrl), so a stale config `oauth.key` is ignored.
 */
export function resolveKimiCodeRuntimeAuth(
  configToml: string,
  env: NodeJS.ProcessEnv = process.env
): KimiCodeRuntimeAuth {
  const provider = readManagedProviderConfig(configToml)
  const envBaseUrl = env.KIMI_CODE_BASE_URL
  const envOAuthHost = env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST
  const hasEnvOverride = envBaseUrl !== undefined || envOAuthHost !== undefined
  const baseUrl = envBaseUrl !== undefined ? stripTrailingSlashes(envBaseUrl) : provider?.base_url
  const oauthHost = hasEnvOverride ? envOAuthHost : provider?.oauth?.oauth_host

  const effectiveHost = stripTrailingSlashes((oauthHost ?? DEFAULT_OAUTH_HOST).trim())
  const effectiveBaseUrl = stripTrailingSlashes(baseUrl ?? DEFAULT_BASE_URL)
  const isShared = effectiveHost === DEFAULT_OAUTH_HOST && effectiveBaseUrl === DEFAULT_BASE_URL
  // Key order matters: the CLI hashes JSON.stringify({ oauthHost, baseUrl }).
  const scope = JSON.stringify({ oauthHost: effectiveHost, baseUrl: effectiveBaseUrl })
  return {
    tokenName: isShared
      ? 'kimi-code'
      : `kimi-code-env-${createHash('sha256').update(scope).digest('hex').slice(0, 16)}`,
    usageUrl: `${effectiveBaseUrl}/usages`
  }
}
