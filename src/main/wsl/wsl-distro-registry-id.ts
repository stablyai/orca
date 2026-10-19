/**
 * A distro's registration GUID (`HKCU\...\Lxss\{guid}`): stable across a rename and changed by an
 * unregister + re-import, so it tells "the same distro" from "a new one with the old name".
 */
import { runProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'

const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
const REG_QUERY_TIMEOUT_MS = 5_000
const GUID_SUBKEY = /\\\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\s*$/i
const VALUE_LINE = /^\s+(\S+)\s+REG_\w+\s+(.*?)\s*$/

export type WslDistroRegistration = {
  /** Canonical form: lowercase and unbraced, as the deployment record's `distroId` stores it. */
  id: string
  distro: string
  /** WSL 1 or 2 from the key's `Version`; null when the registry did not say. */
  version: 1 | 2 | null
}

/** Parses `reg query <Lxss> /s`; matched by shape, since the footer is localized. */
export function parseWslDistroRegistrations(output: string): WslDistroRegistration[] {
  const registrations: WslDistroRegistration[] = []
  let current: { id: string; distro: string | null; version: 1 | 2 | null } | null = null
  const flush = (): void => {
    if (current?.distro) {
      registrations.push({ id: current.id, distro: current.distro, version: current.version })
    }
  }
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      flush()
      const key = GUID_SUBKEY.exec(line)
      current = key?.[1] ? { id: key[1].toLowerCase(), distro: null, version: null } : null
      continue
    }
    const value = VALUE_LINE.exec(line)
    if (!current || !value) {
      continue
    }
    if (value[1] === 'DistributionName') {
      current.distro = value[2]
    } else if (value[1] === 'Version') {
      const version = Number.parseInt(value[2], 16)
      current.version = version === 1 || version === 2 ? version : null
    }
  }
  flush()
  return registrations
}

export type RegQuery = (args: string[]) => Promise<{ code: number | null; stdout: string }>

const defaultRegQuery: RegQuery = (args) =>
  // One reg.exe per lookup, as `openssh-default-shell` reads the registry; never powershell.exe.
  runProcess({
    program: windowsSystem32Binary('reg.exe'),
    args,
    timeoutMs: REG_QUERY_TIMEOUT_MS
  })

/** Every registered distro, or null when the registry cannot be read. */
export async function readWslDistroRegistrations(
  query: RegQuery = defaultRegQuery
): Promise<WslDistroRegistration[] | null> {
  if (process.platform !== 'win32' && query === defaultRegQuery) {
    return null
  }
  let result: { code: number | null; stdout: string }
  try {
    result = await query(['query', LXSS_KEY, '/s'])
  } catch {
    return null
  }
  return result.code === 0 ? parseWslDistroRegistrations(result.stdout) : null
}

/** The distro's registration GUID (lowercase, unbraced), or null when it is not registered or unreadable. */
export async function readWslDistroRegistryId(
  distro: string,
  query: RegQuery = defaultRegQuery
): Promise<string | null> {
  // WSL treats distro names case-insensitively.
  const wanted = distro.trim().toLowerCase()
  const matches = (await readWslDistroRegistrations(query))?.filter(
    (registration) => registration.distro.toLowerCase() === wanted
  )
  return matches?.length === 1 ? matches[0].id : null
}

const SHARED_READ_TTL_MS = 30_000
const sharedReads = new Map<string, { at: number; id: Promise<string | null> }>()

/**
 * One registry read shared by everything a single deploy does (the record's `distroId`, the
 * launch env), so a launch never adds a `reg.exe` of its own. Short-lived: an unregister and
 * re-import changes the id, and the next deploy must see it.
 */
export function readWslDistroRegistryIdShared(
  distro: string,
  now: () => number = Date.now,
  read: (distro: string) => Promise<string | null> = readWslDistroRegistryId
): Promise<string | null> {
  const key = distro.trim().toLowerCase()
  const cached = sharedReads.get(key)
  if (cached && now() - cached.at < SHARED_READ_TTL_MS) {
    return cached.id
  }
  const id = read(distro).catch(() => null)
  sharedReads.set(key, { at: now(), id })
  return id
}

export function resetWslDistroRegistryIdSharedReadsForTests(): void {
  sharedReads.clear()
}
