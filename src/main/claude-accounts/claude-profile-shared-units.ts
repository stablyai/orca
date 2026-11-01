import { createHash } from 'node:crypto'

/** One shared value (a setting, an MCP server, one approval list), keyed by its JSON path. */
export type SharedUnits = Map<string, unknown>

/** Hashes of the shared values both folders held after the last reconcile. */
export type SharedHashes = Record<string, string>

const ABSENT = 'absent'
// Recorded for a value another writer changed during the reconcile: treated as no base.
const UNKNOWN = 'unknown'

function unitKey(...path: string[]): string {
  return JSON.stringify(path)
}

function unitPath(key: string): string[] {
  const path: unknown = JSON.parse(key)
  return Array.isArray(path) ? path.map(String) : []
}

function hashOf(value: unknown): string {
  return value === undefined
    ? ABSENT
    : createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function hashUnits(units: SharedUnits): SharedHashes {
  return Object.fromEntries([...units].map(([key, value]) => [key, hashOf(value)]))
}

/** Record only what the user's file still held after the write. */
export function agreedHashes(written: SharedUnits, reread: SharedUnits): SharedHashes {
  const hashes: SharedHashes = {}
  for (const key of new Set([...written.keys(), ...reread.keys()])) {
    const hash = hashOf(written.get(key))
    hashes[key] = hash === hashOf(reread.get(key)) ? hash : UNKNOWN
  }
  return hashes
}

export function sameUnits(left: SharedUnits, right: SharedUnits): boolean {
  return (
    left.size === right.size &&
    [...left].every(([key, value]) => hashOf(value) === hashOf(right.get(key)))
  )
}

/** Which side's missing values may count as deletions; a recreated or Orca-made file's may not. */
type DeletionTrust = { user: boolean; account: boolean }

/** A change on either side beats the other side's unchanged copy; the user's own folder wins a conflict. */
function reconcileUnit(
  user: unknown,
  account: unknown,
  base: string | undefined,
  trust: DeletionTrust
): unknown {
  const userHash = hashOf(user)
  const accountHash = hashOf(account)
  if (userHash === accountHash) {
    return user
  }
  // Without a base, a value only one side has was added there or removed from the other: keep it.
  if (base === undefined) {
    return user ?? account
  }
  if (accountHash === base) {
    return user === undefined && !trust.user ? account : user
  }
  if (userHash === base) {
    return account === undefined && !trust.account ? user : account
  }
  // A deletion never wins a conflict.
  return user ?? account
}

export function reconcileSharedUnits(
  user: SharedUnits,
  account: SharedUnits,
  base: SharedHashes | null,
  trust: DeletionTrust
): SharedUnits {
  const result: SharedUnits = new Map()
  for (const key of new Set([...user.keys(), ...account.keys(), ...Object.keys(base ?? {})])) {
    const recorded = base ? (base[key] ?? ABSENT) : undefined
    const value = reconcileUnit(
      user.get(key),
      account.get(key),
      recorded === UNKNOWN ? undefined : recorded,
      trust
    )
    if (value !== undefined) {
      result.set(key, value)
    }
  }
  return result
}

/** Keep a value Claude changed in the account after the reconcile read it; it flows back next time. */
export function applyUnlessChangedSince(
  reconciled: SharedUnits,
  latest: SharedUnits,
  read: SharedUnits
): SharedUnits {
  const result: SharedUnits = new Map()
  for (const key of new Set([...reconciled.keys(), ...latest.keys(), ...read.keys()])) {
    const value =
      hashOf(latest.get(key)) === hashOf(read.get(key)) ? reconciled.get(key) : latest.get(key)
    if (value !== undefined) {
      result.set(key, value)
    }
  }
  return result
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Orca installs its own entries here in each account, so these copy one way from the user.
const ONE_WAY_SETTINGS: ReadonlySet<string> = new Set(['hooks', 'statusLine'])

export function settingsUnits(settings: Record<string, unknown>): SharedUnits {
  return new Map(
    Object.entries(settings)
      .filter(([key]) => !ONE_WAY_SETTINGS.has(key))
      .map(([key, value]): [string, unknown] => [unitKey(key), value])
  )
}

export function withSettingsUnits(
  oneWay: Record<string, unknown>,
  units: SharedUnits
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const key of ONE_WAY_SETTINGS) {
    if (oneWay[key] !== undefined) {
      next[key] = oneWay[key]
    }
  }
  for (const [key, value] of units) {
    next[unitPath(key)[0]] = value
  }
  return next
}

// Values the user sets on purpose; counters, caches and stats stay one-way to avoid churn writes.
const PROJECT_UNIT_KEYS = ['enabledMcpjsonServers', 'disabledMcpjsonServers', 'allowedTools']

// Claude writes empty lists into every folder it opens; they carry no choice.
function isChoice(value: unknown): boolean {
  return value !== undefined && !(Array.isArray(value) && value.length === 0)
}

export function stateUnits(config: Record<string, unknown>): SharedUnits {
  const units: SharedUnits = new Map()
  if (isPlainRecord(config.mcpServers)) {
    for (const [name, server] of Object.entries(config.mcpServers)) {
      units.set(unitKey('mcpServers', name), server)
    }
  }
  if (isPlainRecord(config.projects)) {
    for (const [folder, entry] of Object.entries(config.projects)) {
      if (!isPlainRecord(entry)) {
        continue
      }
      if (isPlainRecord(entry.mcpServers)) {
        for (const [name, server] of Object.entries(entry.mcpServers)) {
          units.set(unitKey('projects', folder, 'mcpServers', name), server)
        }
      }
      for (const key of PROJECT_UNIT_KEYS) {
        // Claude writes empty lists into every folder it opens; they carry no choice.
        if (isChoice(entry[key])) {
          units.set(unitKey('projects', folder, key), entry[key])
        }
      }
    }
  }
  return units
}

/** Replace the shared values in `config`, keeping everything else (login, caches, stats). */
export function withStateUnits(
  config: Record<string, unknown>,
  units: SharedUnits
): Record<string, unknown> {
  const next = { ...config }
  const servers: Record<string, unknown> = {}
  const folderServers = new Map<string, Record<string, unknown>>()
  const folderValues = new Map<string, Record<string, unknown>>()
  const slot = (map: Map<string, Record<string, unknown>>, folder: string) => {
    const entry = map.get(folder) ?? {}
    map.set(folder, entry)
    return entry
  }
  for (const [key, value] of units) {
    const path = unitPath(key)
    if (path[0] === 'mcpServers') {
      servers[path[1]] = value
    } else if (path[2] === 'mcpServers') {
      slot(folderServers, path[1])[path[3]] = value
    } else {
      slot(folderValues, path[1])[path[2]] = value
    }
  }
  // Leave a malformed section alone rather than replacing it.
  if (
    isPlainRecord(config.mcpServers) ||
    (config.mcpServers === undefined && Object.keys(servers).length > 0)
  ) {
    next.mcpServers = servers
  }
  if (config.projects !== undefined && !isPlainRecord(config.projects)) {
    return next
  }
  const projects: Record<string, unknown> = isPlainRecord(config.projects)
    ? { ...config.projects }
    : {}
  const folders = new Set([
    ...Object.keys(projects),
    ...folderServers.keys(),
    ...folderValues.keys()
  ])
  for (const folder of folders) {
    const current = projects[folder]
    if (current !== undefined && !isPlainRecord(current)) {
      continue
    }
    const entry: Record<string, unknown> = isPlainRecord(current) ? { ...current } : {}
    const ownServers = folderServers.get(folder)
    if (ownServers || isPlainRecord(entry.mcpServers)) {
      entry.mcpServers = ownServers ?? {}
    }
    const values = folderValues.get(folder) ?? {}
    for (const key of PROJECT_UNIT_KEYS) {
      if (values[key] !== undefined) {
        entry[key] = values[key]
      } else if (isChoice(entry[key])) {
        delete entry[key]
      }
    }
    projects[folder] = entry
  }
  if (config.projects !== undefined || folders.size > 0) {
    next.projects = projects
  }
  return next
}
