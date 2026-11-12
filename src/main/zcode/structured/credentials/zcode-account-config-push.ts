import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import type { ZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection-types'
import { zcodePlanProviderId, type ZcodeChatCredentials } from './zcode-chat-credentials'

// Headless app-servers build their provider registry from the bundled builtin table, the personal
// provider config, and an ACCOUNT snapshot their host pushes over `provider/updateAccountConfig`.
// Without the push every `account:*` plan model is missing from `settings.model.available` and
// `session/setModel` fails with "Provider Registry 中不存在 Model". The snapshot must carry the
// exact `basedOnZCodeBuiltinRevision` the runtime derived from ITS OWN builtin table path; the
// hash covers the resolved path, not the bytes.

type BuiltinProviderTable = {
  revision?: number
  config?: {
    providerConfigRules?: {
      providerRules?: readonly {
        providerId?: string
        config?: {
          access?: { type?: string; mode?: string }
          builtinModelIds?: readonly string[]
        }
      }[]
    }
  }
}

type ReadTable = { table: BuiltinProviderTable; file: string }

let tableCache: { key: string; found: ReadTable | null } | null = null

/** The builtin table the spawned runtime actually booted from, memoized by stat key. */
export function readZcodeBuiltinTable(builtinEnvPath: string | null): ReadTable | null {
  const file = builtinEnvPath?.trim() ? builtinEnvPath : null
  if (!file || !existsSync(file)) {
    return null
  }
  try {
    const { ino, size, mtimeMs, ctimeMs } = statSync(file)
    const key = `${file}\u0000${ino}:${size}:${mtimeMs}:${ctimeMs}`
    if (tableCache?.key !== key) {
      tableCache = { key, found: { table: JSON.parse(readFileSync(file, 'utf8')), file } }
    }
    return tableCache.found
  } catch {
    return null
  }
}

export function zcodeBuiltinRevision(found: ReadTable): string {
  const hash = createHash('sha256').update(resolvePath(found.file)).digest('hex')
  return `zcode-builtin:${found.table.revision ?? 0}:${hash}`
}

/** `zcode-builtin` marker of the standalone-account refusal, so starts can retry on a bundle. */
const STANDALONE_ACCOUNT_MARKER = /Standalone Account|本进程管理/u

export function isZcodeStandaloneAccountRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'ZcodeAppServerRequestError' &&
    STANDALONE_ACCOUNT_MARKER.test(error.message)
  )
}

/** The models the builtin table declares for `providerId`; absent means the push omits them. */
export function zcodeBuiltinModelIds(found: ReadTable, providerId: string): readonly string[] {
  const rules = found.table.config?.providerConfigRules?.providerRules ?? []
  const rule = rules.find((entry) => entry.providerId === providerId)
  return rule?.config?.builtinModelIds ?? []
}

/**
 * Push the account snapshot so the session's model registry carries the plan's models. Best
 * effort: a refusal leaves third-party models only; an unknown method is a quiet no-op. The
 * declared model ids ride along: the backend's own `model.available` lists only the selection,
 * so the push's list is what a chat's picker builds its menu from.
 */
export async function pushZcodeAccountConfig(
  connection: ZcodeAppServerConnection,
  table: ReadTable | null,
  credentials: ZcodeChatCredentials | null,
  timeoutMs = 10_000
): Promise<{
  pushed: boolean
  refusedStandaloneAccount: boolean
  declaredModels: readonly { providerId: string; modelId: string }[]
}> {
  const providerId = credentials ? zcodePlanProviderId(credentials.site) : null
  if (!table || !providerId) {
    return { pushed: false, refusedStandaloneAccount: false, declaredModels: [] }
  }
  const models = zcodeBuiltinModelIds(table, providerId)
  const declaredModels = models.map((modelId) => ({ providerId, modelId }))
  const payload = {
    revision: `account:orca:${Date.now()}`,
    basedOnZCodeBuiltinRevision: zcodeBuiltinRevision(table),
    providers: {
      [providerId]: {
        ...(models.length > 0 ? { builtinModelIds: models } : {}),
        access: { type: 'zhipu-account', entitled: true }
      }
    },
    states: {
      [providerId]: { availability: 'available', entitled: true, current: true }
    }
  }
  try {
    await connection.request('provider/updateAccountConfig', payload, { timeoutMs })
    return { pushed: true, refusedStandaloneAccount: false, declaredModels }
  } catch (error) {
    if (isZcodeStandaloneAccountRefusal(error)) {
      return { pushed: false, refusedStandaloneAccount: true, declaredModels }
    }
    // Unknown-method refusals and transient failures never block the chat.
    return { pushed: false, refusedStandaloneAccount: false, declaredModels }
  }
}
