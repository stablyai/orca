import {
  getOpenCodeApiKeyRecord,
  readOpenCodeAuthJson,
  type OpenCodeAuthRecord
} from '../opencode/opencode-auth-store'

export const ZAI_CODING_PLAN_PROVIDER_ID = 'zai-coding-plan'

export const DEFAULT_ZAI_ORIGIN = 'https://api.z.ai'

// Why: the quota monitor only answers on the two GLM Coding Plan hosts; a
// payload field pointing anywhere else must never redirect the key elsewhere.
const ALLOWED_ZAI_ORIGINS: readonly string[] = [DEFAULT_ZAI_ORIGIN, 'https://open.bigmodel.cn']

// Where a custom base URL may hide inside a provider record: the record body
// itself or its metadata/config sub-objects.
const ORIGIN_FIELDS: readonly string[] = ['baseURL', 'base_url', 'baseUrl', 'apiBase']
const ORIGIN_CONTAINERS: readonly string[] = ['metadata', 'config']

export type ZaiCredentialsResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; key: string; origin: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function allowedOriginFromValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }
  try {
    const url = new URL(value.trim())
    return ALLOWED_ZAI_ORIGINS.includes(url.origin) ? url.origin : null
  } catch {
    return null
  }
}

/**
 * Infer which GLM Coding Plan host a record belongs to from its
 * metadata/config when recognizable; otherwise the global default.
 */
export function resolveZaiOrigin(record: OpenCodeAuthRecord | null): string {
  if (!record) {
    return DEFAULT_ZAI_ORIGIN
  }
  const containers = [record]
  for (const key of ORIGIN_CONTAINERS) {
    const nested = asRecord(record[key])
    if (nested) {
      containers.push(nested)
    }
  }
  for (const container of containers) {
    for (const field of ORIGIN_FIELDS) {
      const origin = allowedOriginFromValue(container[field])
      if (origin) {
        return origin
      }
    }
  }
  return DEFAULT_ZAI_ORIGIN
}

/**
 * Read-only Z.AI Coding Plan credentials from OpenCode's auth.json. The key
 * lifecycle is owned by `opencode auth login`; Orca never writes that file.
 */
export async function readZaiCredentials(): Promise<ZaiCredentialsResult> {
  const auth = await readOpenCodeAuthJson()
  if (auth.status !== 'ok') {
    return auth
  }
  const record = getOpenCodeApiKeyRecord(auth.auth, ZAI_CODING_PLAN_PROVIDER_ID)
  if (!record) {
    return { status: 'missing' }
  }
  // Why: origin hints live on the raw record; strict extraction drops extras.
  return {
    status: 'ok',
    key: record.key.trim(),
    origin: resolveZaiOrigin(asRecord(auth.auth[ZAI_CODING_PLAN_PROVIDER_ID]))
  }
}

/** Durable `zaiAuthConfigured` signal: a nonempty Coding Plan key is on disk. */
export async function isZaiAuthConfigured(): Promise<boolean> {
  const auth = await readOpenCodeAuthJson()
  return (
    auth.status === 'ok' && getOpenCodeApiKeyRecord(auth.auth, ZAI_CODING_PLAN_PROVIDER_ID) !== null
  )
}
