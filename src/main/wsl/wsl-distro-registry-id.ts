/** Lxss registration GUID survives rename but changes on unregister/reimport, distinguishing replacement distros with reused names. */
import { runProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
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

const DEFAULT_DISTRIBUTION_LINE = /^\s+DefaultDistribution\s+REG_SZ\s+\{?([0-9a-f-]{36})\}?\s*$/im

/** The default distro's registration GUID from the Lxss root, lowercase and unbraced; null when unset. */
export function parseDefaultWslDistroId(output: string): string | null {
  return DEFAULT_DISTRIBUTION_LINE.exec(output)?.[1]?.toLowerCase() ?? null
}

export type RegQuery = (args: string[]) => Promise<{ code: number | null; stdout: string }>

function regQuerySpec(args: string[]): ProcessSpec {
  // Read registry with reg.exe, never PowerShell, matching openssh-default-shell.
  return { program: windowsSystem32Binary('reg.exe'), args, timeoutMs: REG_QUERY_TIMEOUT_MS }
}

/** `reg query <Lxss> /s`, for readers that run it themselves. */
export function lxssRegQuerySpec(): ProcessSpec {
  return regQuerySpec(['query', LXSS_KEY, '/s'])
}

const defaultRegQuery: RegQuery = (args) => runProcess(regQuerySpec(args))

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
  const wanted = distro.trim().toLowerCase()
  const matches = (await readWslDistroRegistrations(query))?.filter(
    (registration) => registration.distro.toLowerCase() === wanted
  )
  return matches?.length === 1 ? matches[0].id : null
}

/**
 * The distro's current registered name: by its recorded GUID first (it survives a rename), else
 * by name. False when neither is registered; null when the registrations can't be read.
 */
export async function resolveWslDistroName(
  distro: string,
  distroGuid?: string,
  query: RegQuery = defaultRegQuery
): Promise<string | false | null> {
  const registrations = await readWslDistroRegistrations(query)
  if (!registrations) {
    return null
  }
  const guid = distroGuid?.trim().replace(/[{}]/g, '').toLowerCase()
  const wanted = distro.trim().toLowerCase()
  const match =
    (guid && registrations.find((entry) => entry.id === guid)) ||
    registrations.find((entry) => entry.distro.toLowerCase() === wanted)
  return match ? match.distro : false
}

/**
 * Whether the distro is registered, by name or (after a rename) by its recorded GUID; null when
 * the registrations cannot be read.
 */
export async function isWslDistroRegistered(
  distro: string,
  distroGuid?: string,
  query: RegQuery = defaultRegQuery
): Promise<boolean | null> {
  const name = await resolveWslDistroName(distro, distroGuid, query)
  return name === null ? null : name !== false
}

const SHARED_READ_TTL_MS = 30_000
const sharedReads = new Map<string, { at: number; id: Promise<string | null> }>()

/** Share one registry read within a deploy; discard afterward so unregister/reimport gets a new identity next time. */
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
