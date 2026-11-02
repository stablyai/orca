// The Account Config a zcode app-server needs before its first `session/create`: the desktop
// host pushes the account providers here, and without it the CLI Registry carries only the
// Personal config and resolves every new session onto its factory default (openai) — never
// the GLM Coding Plan the user actually logs in with.
//
// The push is membership-and-entitlement facts only — builtin model ids and access marks —
// never credentials: the upstream schema comment says exactly that ("Account 运行时事实仍只有
// 成员及权益"), and the CLI reads the secrets itself from the shared credential store whose
// file Orca only ever lists key names of.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

export type ZcodeAccountConfigPush = {
  revision: string
  basedOnZCodeBuiltinRevision: string
  providers: Record<
    string,
    {
      builtinModelIds: string[]
      access: { type: 'zhipu-account'; entitled: boolean } | null
    }
  >
  states: Record<
    string,
    {
      entitled: boolean
      availability: 'available' | 'pending' | 'unavailable' | 'unknown'
      current: boolean
    }
  >
}

const connectionSelectionsShape = z.looseObject({
  providerFamilyConnectionSelections: z
    .object({
      zai: z
        .looseObject({ kind: z.enum(['start-plan', 'individual-coding-plan', 'team-coding-plan']) })
        .optional(),
      bigmodel: z
        .looseObject({ kind: z.enum(['start-plan', 'individual-coding-plan', 'team-coding-plan']) })
        .optional()
    })
    .optional()
})

const builtInRulesShape = z.object({
  revision: z.union([z.number().int().positive(), z.string().min(1)]),
  config: z.object({
    providerConfigRules: z.object({
      providerRules: z.array(
        z.object({
          providerId: z.string().min(1),
          config: z.object({
            access: z.object({ type: z.string() }).loose().nullable().optional(),
            builtinModelIds: z.array(z.string()).optional()
          })
        })
      )
    })
  })
})

function isBuiltInRules(value: unknown): value is z.infer<typeof builtInRulesShape> {
  return builtInRulesShape.safeParse(value).success
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Newest `zcode-builtin.json` under the CLI's provider cache, for launches whose
 *  environment does not carry the desktop's path variables (Orca started standalone). */
export function findZcodeBuiltinProviderConfigFile(dataBaseDir: string): string | null {
  const cacheRoot = join(dataBaseDir, '.zcode', 'v2', 'runtime', 'provider')
  let newest: { path: string; mtimeMs: number } | null = null
  try {
    for (const platform of readdirSync(cacheRoot)) {
      for (const version of readdirSync(join(cacheRoot, platform))) {
        for (const endpoint of readdirSync(join(cacheRoot, platform, version))) {
          const candidate = join(cacheRoot, platform, version, endpoint, 'zcode-builtin.json')
          try {
            const mtimeMs = statSync(candidate).mtimeMs
            if (!newest || mtimeMs > newest.mtimeMs) {
              newest = { path: candidate, mtimeMs }
            }
          } catch {
            // A directory entry that is not a readable cache version; skip it.
          }
        }
      }
    }
  } catch {
    return null
  }
  return newest?.path ?? null
}

function selectedAccountProviderId(settingsPath: string | null): string | null {
  if (!settingsPath) {
    return null
  }
  const parsed = connectionSelectionsShape.safeParse(readJson(settingsPath))
  if (!parsed.success) {
    return null
  }
  const selections = parsed.data.providerFamilyConnectionSelections
  const selected = (['zai', 'bigmodel'] as const).flatMap((family) => {
    const selection = selections?.[family]
    return selection ? [`account:${family}-${selection.kind}`] : []
  })
  return selected.length === 1 ? selected[0] : null
}

function readCodingPlanCredentialKeys(credentialsPath: string | null): Set<string> {
  if (!credentialsPath) {
    return new Set()
  }
  const parsed = readJson(credentialsPath)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Set()
  }
  return new Set(Object.keys(parsed))
}

/** Builds the push from the Built-in provider catalog (the `account:` instances the CLI
 *  ships) and the shared credential store's key names. Null when there is nothing to
 *  inject: no Built-in file, or no zhipu-account instance in it. */
export function buildZcodeAccountConfigPush(args: {
  builtInPath: string | null
  credentialsPath: string | null
  settingsPath?: string | null
}): ZcodeAccountConfigPush | null {
  if (!args.builtInPath) {
    return null
  }
  const builtIn = readJson(args.builtInPath)
  const built = isBuiltInRules(builtIn) ? builtIn : null
  if (!built) {
    return null
  }
  const rules = built.config.providerConfigRules.providerRules
  // The CLI's Registry only accepts a push whose `basedOn` matches ITS OWN config source's
  // revision string exactly — `zcode-builtin:<release revision>:<sha256 of the active
  // file's absolute path>` (zcode-builtin-provider-config-source.ts). Any other spelling,
  // including the bare release number, silently skips the rebuild and keeps the old
  // (unentitled) Registry.
  const basedOnZCodeBuiltinRevision = `zcode-builtin:${built.revision}:${createHash('sha256')
    .update(resolve(args.builtInPath))
    .digest('hex')}`

  const credentialKeys = readCodingPlanCredentialKeys(args.credentialsPath)
  const currentProviderId = selectedAccountProviderId(args.settingsPath ?? null)
  const providers: ZcodeAccountConfigPush['providers'] = {}
  const states: ZcodeAccountConfigPush['states'] = {}
  for (const rule of rules) {
    const access = rule.config.access
    if (access?.type !== 'zhipu-account' || !rule.providerId.startsWith('account:')) {
      continue
    }
    // Entitled = the shared credential store holds a Coding Plan key for this provider,
    // under either key layout the CLI has used (`account:` instance id or bare id).
    const bareId = rule.providerId.slice('account:'.length)
    const entitled = [...credentialKeys].some(
      (key) =>
        key.includes(`coding-plan:account:${bareId}:`) ||
        key.includes(`coding-plan:account:${rule.providerId}:`)
    )
    providers[rule.providerId] = {
      builtinModelIds: Array.isArray(rule.config.builtinModelIds)
        ? rule.config.builtinModelIds.filter((id) => typeof id === 'string' && id.trim())
        : [],
      access: { type: 'zhipu-account', entitled }
    }
    states[rule.providerId] = {
      entitled,
      availability: entitled ? 'available' : 'unknown',
      current: entitled && rule.providerId === currentProviderId
    }
  }
  if (Object.keys(providers).length === 0) {
    return null
  }
  return {
    revision: '1',
    basedOnZCodeBuiltinRevision,
    providers,
    states
  }
}

/** The launch-env paths the push reads, resolved the way the CLI itself resolves them. */
export function resolveZcodeAccountConfigPaths(args: {
  launchEnv: Record<string, string>
  cwd?: string
}): { builtInPath: string | null; credentialsPath: string; settingsPath: string } {
  const launchEnv = args.launchEnv ?? {}
  const dataBaseDir =
    launchEnv.ZCODE_DATA_BASE_DIR ?? launchEnv.HOME ?? launchEnv.USERPROFILE ?? homedir()
  const builtInPath =
    launchEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() ||
    findZcodeBuiltinProviderConfigFile(dataBaseDir)
  return {
    builtInPath: builtInPath || null,
    credentialsPath: join(dataBaseDir, '.zcode', 'v2', 'credentials.json'),
    settingsPath: join(dataBaseDir, '.zcode', 'v2', 'setting.json')
  }
}

/** Pushes the Account Config (and refreshes the Registry) over an already-spawned
 *  app-server connection, before any session/create resolves its model. Returns whether
 *  a push was applied; every failure degrades to the CLI's factory default. */
export async function syncZcodeAccountConfig(
  connection: {
    request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  },
  launchEnv: Record<string, string>
): Promise<boolean> {
  const paths = resolveZcodeAccountConfigPaths({ launchEnv })
  const push = buildZcodeAccountConfigPush(paths)
  if (!push) {
    return false
  }
  try {
    await connection.request('provider/updateAccountConfig', push, undefined)
    await connection.request('provider/refreshRegistry', { reason: 'orca-session-open' }, undefined)
    return true
  } catch {
    return false
  }
}
