import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const USER_ENV_KEY = 'HKCU\\Environment'
const MACHINE_ENV_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

/**
 * Parse one `reg query` Environment key's output into a name → raw value map.
 *
 * Rows look like `    ORCA_GITEA_TOKEN    REG_SZ    abc123` (four-space
 * separators; the type may be REG_SZ or REG_EXPAND_SZ). Pure so the parsing
 * contract is unit-testable without touching the registry.
 */
export function parseRegQueryEnvOutput(stdout: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('HKEY_')) {
      continue
    }
    const match = /^(.+?)\s{2,}(REG_SZ|REG_EXPAND_SZ)\s{2,}(.*)$/.exec(line)
    if (!match) {
      continue
    }
    values[match[1].trim()] = match[3]
  }
  return values
}

/**
 * Expand `%VAR%` references the way the registry's REG_EXPAND_SZ intends:
 * against the merged view (machine values under user values over the process
 * environment), falling back to the reference text when the name is unknown —
 * the same behaviour `ExpandEnvironmentStrings` has.
 */
export function expandRegistryEnvValue(
  value: string,
  merged: Record<string, string | undefined>
): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const resolved = merged[name]
    return resolved !== undefined && resolved.length > 0 ? resolved : whole
  })
}

/**
 * Merge registry Environment values over a base environment. Machine values
 * apply first and user values win, matching how Windows builds the environment
 * for a fresh process. A registry row always beats a stale inherited value,
 * because the registry is the authoritative store the user edited (#14740).
 */
export function mergeRegistryEnv(
  base: Record<string, string | undefined>,
  machine: Record<string, string>,
  user: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (typeof value === 'string') {
      merged[name] = value
    }
  }
  for (const [name, raw] of Object.entries(machine)) {
    merged[name] = expandRegistryEnvValue(raw, merged)
  }
  for (const [name, raw] of Object.entries(user)) {
    merged[name] = expandRegistryEnvValue(raw, merged)
  }
  return merged
}

let cachedOverridePromise: Promise<Record<string, string>> | null = null
const REFRESH_CACHE_MS = 5_000
let cachedAt = 0

/**
 * Current Windows user+machine Environment values from the registry.
 *
 * Why: a GUI app launched from a shortcut inherits Explorer's environment
 * SNAPSHOT, and Explorer does not refresh it when the user edits variables —
 * so a packaged build keeps a rotated token or outdated URL until sign-out,
 * while a dev build launched from a fresh terminal works (#14740). The
 * registry is the authoritative store; reading it at check time makes the
 * card's "restart Orca if environment variables changed" hint unnecessary.
 *
 * Best-effort: any failure yields an empty overlay, so callers keep the
 * inherited environment exactly as before. Non-Windows always returns {}.
 */
export async function readCurrentWindowsEnvOverrides(): Promise<Record<string, string>> {
  if (process.platform !== 'win32') {
    return {}
  }
  const now = Date.now()
  if (cachedOverridePromise && now - cachedAt < REFRESH_CACHE_MS) {
    return cachedOverridePromise
  }
  cachedAt = now
  cachedOverridePromise = (async () => {
    const read = async (key: string): Promise<Record<string, string>> => {
      try {
        const { stdout } = await execFileAsync('reg', ['query', key], {
          windowsHide: true,
          timeout: 4000
        })
        return parseRegQueryEnvOutput(stdout)
      } catch {
        return {}
      }
    }
    const machine = await read(MACHINE_ENV_KEY)
    const user = await read(USER_ENV_KEY)
    // Only names the registry actually carries become overrides; everything
    // else keeps the inherited value (dynamic per-shell variables survive).
    const overrides: Record<string, string> = {}
    const merged = mergeRegistryEnv(process.env, machine, user)
    for (const name of new Set([...Object.keys(machine), ...Object.keys(user)])) {
      const value = merged[name]
      if (typeof value === 'string') {
        overrides[name] = value
      }
    }
    return overrides
  })()
  return cachedOverridePromise
}

/** Test-only cache reset. */
export function clearWindowsEnvOverrideCacheForTests(): void {
  cachedOverridePromise = null
  cachedAt = 0
}
