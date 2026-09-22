import { lookup } from 'node:dns/promises'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import { resolveWithSshG } from './ssh-g-config-resolution'

/** Resolved IPs for a hostname; empty when it cannot be resolved in time. */
export type HostAddressLookup = (host: string) => Promise<string[]>
/** `ssh -G` hostname for an OpenSSH config alias; null when the alias does not resolve. */
export type SshAliasHostnameResolver = (alias: string) => Promise<string | null>

export type CoLocationDeps = {
  lookup: HostAddressLookup
  resolveAlias: SshAliasHostnameResolver
}

type AddressedHost = { id: string; addresses: ReadonlySet<string> }

const LOOKUP_TIMEOUT_MS = 1500
const CACHE_TTL_MS = 30_000
// Why: a loopback endpoint (an SSH-tunnelled server, a local `orca serve`) is this machine, and
// this machine is never the far end of one of its own SSH targets.
const LOOPBACK_RE = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1?|0:0:0:0:0:0:0:[01])$/

export function normalizeHostAddress(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
}

export function endpointHostname(endpoint: string): string | null {
  try {
    const hostname = new URL(endpoint).hostname
    return hostname ? normalizeHostAddress(hostname) : null
  } catch {
    return null
  }
}

async function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), LOOKUP_TIMEOUT_MS)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

const dnsLookup: HostAddressLookup = (host) =>
  withTimeout(
    lookup(host, { all: true }).then(
      (entries) => entries.map((entry) => entry.address),
      () => []
    ),
    []
  )

const sshAliasHostname: SshAliasHostnameResolver = (alias) =>
  withTimeout(
    resolveWithSshG(alias).then(
      (resolved) => resolved?.hostname ?? null,
      () => null
    ),
    null
  )

const DEFAULT_DEPS: CoLocationDeps = { lookup: dnsLookup, resolveAlias: sshAliasHostname }

/** Every name and address a host answers to, or nothing at all when it is this machine. */
export async function collectHostAddresses(
  hosts: readonly string[],
  lookupAddresses: HostAddressLookup
): Promise<Set<string>> {
  const names = new Set(hosts.map(normalizeHostAddress).filter(Boolean))
  if ([...names].some((name) => LOOPBACK_RE.test(name))) {
    return new Set()
  }
  const resolved = await Promise.all([...names].map((name) => lookupAddresses(name)))
  const addresses = new Set(names)
  for (const address of resolved.flat()) {
    addresses.add(normalizeHostAddress(address))
  }
  return addresses
}

/** Target id → id of the first paired server sharing any name or address with it. */
export function matchCoLocatedEnvironments(
  targets: readonly AddressedHost[],
  environments: readonly AddressedHost[]
): Map<string, string> {
  const matches = new Map<string, string>()
  for (const target of targets) {
    const environment = environments.find((candidate) =>
      [...candidate.addresses].some((address) => target.addresses.has(address))
    )
    if (environment) {
      matches.set(target.id, environment.id)
    }
  }
  return matches
}

async function targetAddresses(target: SshTarget, deps: CoLocationDeps): Promise<AddressedHost> {
  const hosts = [target.host]
  if (target.configHost) {
    const resolved = await deps.resolveAlias(target.configHost)
    if (resolved) {
      hosts.push(resolved)
    }
  }
  return { id: target.id, addresses: await collectHostAddresses(hosts, deps.lookup) }
}

async function environmentAddresses(
  environment: KnownRuntimeEnvironment,
  deps: CoLocationDeps
): Promise<AddressedHost> {
  const hosts = environment.endpoints
    .map((endpoint) => endpointHostname(endpoint.endpoint))
    .filter((hostname): hostname is string => hostname !== null)
  return { id: environment.id, addresses: await collectHostAddresses(hosts, deps.lookup) }
}

function fingerprint(
  targets: readonly SshTarget[],
  environments: readonly KnownRuntimeEnvironment[]
): string {
  return JSON.stringify([
    targets.map((target) => [target.id, target.host, target.configHost ?? null]),
    environments.map((environment) => [
      environment.id,
      environment.endpoints.map((endpoint) => endpoint.endpoint)
    ])
  ])
}

let cache: { key: string; expiresAt: number; matches: Map<string, string> } | null = null

/**
 * Which SSH targets dial the same machine a paired Orca server runs on. Mobile and CLI callers
 * list targets often, and each answer may cost a DNS lookup and an `ssh -G` per alias, so the
 * result is held briefly; the inputs themselves are the cache key.
 */
export async function findCoLocatedEnvironmentIds(
  targets: readonly SshTarget[],
  environments: readonly KnownRuntimeEnvironment[],
  deps: CoLocationDeps = DEFAULT_DEPS,
  now = Date.now()
): Promise<Map<string, string>> {
  if (targets.length === 0 || environments.length === 0) {
    return new Map()
  }
  const key = fingerprint(targets, environments)
  if (cache && cache.key === key && cache.expiresAt > now) {
    return new Map(cache.matches)
  }
  const [addressedTargets, addressedEnvironments] = await Promise.all([
    Promise.all(targets.map((target) => targetAddresses(target, deps))),
    Promise.all(environments.map((environment) => environmentAddresses(environment, deps)))
  ])
  const matches = matchCoLocatedEnvironments(addressedTargets, addressedEnvironments)
  cache = { key, expiresAt: now + CACHE_TTL_MS, matches }
  return new Map(matches)
}

export function __resetCoLocationCacheForTests(): void {
  cache = null
}
