import type {
  SshConfigHostListResult,
  SshConfigHostResolution,
  SshConfigHostSummary,
  SshTarget
} from '../../../shared/ssh-types'
import { SSH_CONFIG_HOST_RESULT_LIMIT } from '../../../shared/ssh-types'
import { normalizeSshConfigAlias } from '../../../shared/ssh-config-alias'
import { loadUserSshConfig, type SshConfigHost } from './ssh-config-parser'
import { resolveWithSshG, type SshResolvedConfig } from './ssh-g-config-resolution'

// Cache parsing/Include expansion for picker keystrokes; refresh when reopened.
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
    // Tombstones suppress bulk import, not picker visibility, so deleting a target cannot make config look empty.
    const previouslyRemoved = !alreadyInOrca && suppressedAliasSet.has(normalizedAlias)
    totalHostCount += 1
    // Match passive import: Add all preserves tombstones.
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
  // Re-read config so aliases removed after picker opening cannot become targets.
  loadConfigHosts: () => SshConfigHost[] = () => getUserSshConfigHosts(true)
): Promise<SshConfigHostResolution | null> {
  const configHosts = loadConfigHosts()
  // ssh -G resolves unknown aliases too; only mint targets still present in config.
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
    // Honor explicit Host GSSAPI only; inherited distro defaults must not force an unrequested GSSAPI-first handshake.
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
