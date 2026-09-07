import type {
  SshConfigHostListResult,
  SshConfigHostResolution,
  SshConfigHostSummary,
  SshTarget
} from '../../shared/ssh-types'
import { SSH_CONFIG_HOST_RESULT_LIMIT } from '../../shared/ssh-types'
import { normalizeSshConfigAlias } from '../../shared/ssh-config-alias'
import { loadUserSshConfig, type SshConfigHost } from './ssh-config-parser'
import { resolveWithSshG, type SshResolvedConfig } from './ssh-g-config-resolution'

// Why: every keystroke in the picker filter re-queries the main process. Parsing (and
// Include-expanding) ~/.ssh/config per keystroke is the whole cost, and the file cannot
// change between them, so hold the parse for the picker session and refresh on reopen.
let cachedConfigHosts: SshConfigHost[] | null = null

export function invalidateUserSshConfigHostCache(): void {
  cachedConfigHosts = null
}

function getUserSshConfigHosts(refresh: boolean): SshConfigHost[] {
  if (refresh || cachedConfigHosts === null) {
    cachedConfigHosts = loadUserSshConfig()
  }
  return cachedConfigHosts
}

export function searchSshConfigHosts(
  hosts: SshConfigHost[],
  existingTargets: readonly Pick<SshTarget, 'configHost' | 'label'>[],
  query = '',
  suppressedAliases: readonly string[] = []
): SshConfigHostListResult {
  const existingAliases = new Set(
    existingTargets.flatMap((target) =>
      [target.configHost, target.label].map(normalizeSshConfigAlias).filter(Boolean)
    )
  )
  const normalizedQuery = query.trim().toLowerCase()
  const suppressedAliasSet = new Set(suppressedAliases.map(normalizeSshConfigAlias))
  const summaries: SshConfigHostSummary[] = []
  const seenAliases = new Set<string>()
  let totalHostCount = 0
  let newHostCount = 0
  let matchCount = 0

  for (const entry of hosts) {
    const normalizedAlias = normalizeSshConfigAlias(entry.host)
    if (seenAliases.has(normalizedAlias)) {
      continue
    }
    seenAliases.add(normalizedAlias)
    const alreadyInOrca = existingAliases.has(normalizedAlias)
    // Why: tombstones only block passive bulk import — the picker still lists the
    // Host so deleting one Orca target never looks like "~/.ssh/config is empty".
    const previouslyRemoved = !alreadyInOrca && suppressedAliasSet.has(normalizedAlias)
    totalHostCount += 1
    // Why: "Add all" must match importFromSshConfig without reAdopt (tombstones stay).
    newHostCount += alreadyInOrca || previouslyRemoved ? 0 : 1
    if (!matchesQuery(entry, normalizedQuery)) {
      continue
    }
    matchCount += 1
    if (summaries.length < SSH_CONFIG_HOST_RESULT_LIMIT) {
      summaries.push(toSummary(entry, alreadyInOrca, previouslyRemoved))
    }
  }

  return {
    hosts: summaries,
    totalHostCount,
    newHostCount,
    matchCount,
    hasMore: matchCount > summaries.length
  }
}

export function listUserSshConfigHostSummaries(
  existingTargets: readonly Pick<SshTarget, 'configHost' | 'label'>[],
  query?: string,
  suppressedAliases?: readonly string[],
  options?: { refresh?: boolean }
): SshConfigHostListResult {
  return searchSshConfigHosts(
    getUserSshConfigHosts(options?.refresh === true),
    existingTargets,
    query,
    suppressedAliases
  )
}

export async function resolveUserSshConfigHost(
  alias: string,
  resolver: (host: string) => Promise<SshResolvedConfig | null> = resolveWithSshG,
  // Why: read the file again rather than the picker-session cache — the point of the check
  // below is to catch a row the user edited out of ~/.ssh/config after opening the picker.
  loadConfigHosts: () => SshConfigHost[] = () => getUserSshConfigHosts(true)
): Promise<SshConfigHostResolution | null> {
  const configHosts = loadConfigHosts()
  // Why: `ssh -G` answers for unknown aliases too, echoing the alias back as the hostname.
  // Resolving one would mint a target for a host that is no longer configured.
  if (!configHostMatches(configHosts, alias)) {
    return null
  }
  const resolved = await resolver(alias)
  if (!resolved?.hostname) {
    return null
  }
  return {
    alias,
    hostname: resolved.hostname,
    port: resolved.port,
    username: resolved.user ?? '',
    identityFiles: resolved.identityFile,
    ...(resolved.identityAgent ? { identityAgent: resolved.identityAgent } : {}),
    identitiesOnly: resolved.identitiesOnly,
    forwardAgent: resolved.forwardAgent,
    // Why: `ssh -G` reports the effective value, which on many distros is the /etc/ssh
    // default `GSSAPIAuthentication yes`. Stamping that onto a manual target would force
    // a GSSAPI-first handshake the user never asked for, so honour the Host entry only.
    gssapiAuthentication: configHostRequestsGssapi(configHosts, alias),
    ...(resolved.proxyCommand ? { proxyCommand: resolved.proxyCommand } : {}),
    proxyUseFdpass: resolved.proxyUseFdpass,
    ...(resolved.proxyJump ? { jumpHost: resolved.proxyJump } : {})
  }
}

function configHostMatches(hosts: readonly SshConfigHost[], alias: string): boolean {
  const normalized = normalizeSshConfigAlias(alias)
  return Boolean(normalized) && hosts.some((entry) => matchesAlias(entry, normalized))
}

function configHostRequestsGssapi(hosts: readonly SshConfigHost[], alias: string): boolean {
  const normalized = normalizeSshConfigAlias(alias)
  return hosts.some((entry) => matchesAlias(entry, normalized) && entry.gssapiAuthentication)
}

function matchesAlias(entry: SshConfigHost, normalizedAlias: string): boolean {
  return normalizeSshConfigAlias(entry.host) === normalizedAlias
}

function toSummary(
  entry: SshConfigHost,
  alreadyInOrca: boolean,
  previouslyRemoved = false
): SshConfigHostSummary {
  return {
    alias: entry.host,
    hostname: entry.hostname || entry.host,
    port: entry.port ?? 22,
    username: entry.user ?? '',
    ...(entry.identityFile ? { identityFile: entry.identityFile } : {}),
    ...(entry.proxyCommand ? { proxyCommand: entry.proxyCommand } : {}),
    ...(entry.proxyJump ? { jumpHost: entry.proxyJump } : {}),
    alreadyInOrca,
    ...(previouslyRemoved ? { previouslyRemoved: true } : {})
  }
}

function matchesQuery(entry: SshConfigHost, query: string): boolean {
  return (
    !query ||
    entry.host.toLowerCase().includes(query) ||
    (entry.hostname ?? entry.host).toLowerCase().includes(query) ||
    (entry.user ?? '').toLowerCase().includes(query)
  )
}
