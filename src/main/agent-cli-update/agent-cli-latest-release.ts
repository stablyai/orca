// The newest release of each agent CLI users install themselves, looked up at most hourly.

import { z } from 'zod'
import { getMainHttpClient } from '../network/http-client'
import { CLAUDE_MANAGED_RUNTIME } from '../claude/managed-runtime/claude-managed-runtime'

/** Where an agent publishes the release its own update command installs. */
export type AgentCliReleaseSource =
  | { kind: 'claude' }
  | { kind: 'npm'; package: string }
  | { kind: 'github'; repo: string; tagPrefix: string }
  | { kind: 'acp-registry'; id: string }

const ACP_REGISTRY = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const REFRESH_MS = 60 * 60_000
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const npmLatestSchema = z.object({ version: z.string().regex(VERSION) })
const githubReleaseSchema = z.object({ tag_name: z.string() })
// Other entries may change shape; only the agents Orca reads must parse.
const acpRegistrySchema = z.object({
  agents: z.array(z.object({ id: z.string(), version: z.unknown() }))
})

/** Asks at most hourly with one request in flight; a failure waits out the hour on the last answer. */
function hourly<T>(name: string, fetchValue: () => Promise<T>): () => Promise<T | null> {
  let last: { value: T | null; at: number } | null = null
  let lookup: Promise<void> | null = null
  return async () => {
    if (!last || Date.now() - last.at >= REFRESH_MS) {
      lookup ??= fetchValue()
        .then((value) => {
          last = { value, at: Date.now() }
        })
        .catch((error: unknown) => {
          // Waits out the hour too, so an offline host isn't asked again on every chat start.
          last = { value: last?.value ?? null, at: Date.now() }
          console.warn(`[agent-cli-update] ${name} release lookup failed:`, error)
        })
        .finally(() => {
          lookup = null
        })
      await lookup
    }
    return last?.value ?? null
  }
}

const versionLookups = new Map<string, () => Promise<string | null>>()

function lookUpVersion(key: string, fetchVersion: () => Promise<string>): Promise<string | null> {
  let lookup = versionLookups.get(key)
  if (!lookup) {
    lookup = hourly(key, fetchVersion)
    versionLookups.set(key, lookup)
  }
  return lookup()
}

async function fetchJson(url: string, accept?: string): Promise<unknown> {
  const response = await getMainHttpClient().fetch(
    url,
    accept ? { headers: { Accept: accept } } : {}
  )
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`${url} answered ${response.status}`)
  }
  return response.json()
}

async function npmLatest(pkg: string): Promise<string> {
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2f')}/latest`
  return npmLatestSchema.parse(await fetchJson(url)).version
}

async function githubLatest(repo: string, tagPrefix: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  const tag = githubReleaseSchema.parse(
    await fetchJson(url, 'application/vnd.github+json')
  ).tag_name
  const version = tag.startsWith(tagPrefix) ? tag.slice(tagPrefix.length) : ''
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${repo} latest release has an unexpected tag ${tag}`)
  }
  return version
}

async function acpRegistryVersions(): Promise<Map<string, string>> {
  const { agents } = acpRegistrySchema.parse(await fetchJson(ACP_REGISTRY))
  const versions = new Map<string, string>()
  for (const { id, version } of agents) {
    if (typeof version === 'string' && VERSION.test(version)) {
      versions.set(id, version)
    }
  }
  return versions
}

const acpRegistryLookup = hourly('ACP registry', acpRegistryVersions)

async function refreshClaudeLatest(): Promise<string | null> {
  // Shares Orca's own Claude lookup, which follows the user's update channel.
  await CLAUDE_MANAGED_RUNTIME.refreshPin?.().catch((error: unknown) => {
    console.warn('[agent-cli-update] Claude release lookup failed:', error)
  })
  return CLAUDE_MANAGED_RUNTIME.pin()?.version ?? null
}

export async function latestAgentCliRelease(source: AgentCliReleaseSource): Promise<string | null> {
  switch (source.kind) {
    case 'claude':
      return refreshClaudeLatest()
    case 'npm':
      return lookUpVersion(`npm ${source.package}`, () => npmLatest(source.package))
    case 'github':
      return lookUpVersion(`GitHub ${source.repo}`, () =>
        githubLatest(source.repo, source.tagPrefix)
      )
    case 'acp-registry':
      return (await acpRegistryLookup())?.get(source.id) ?? null
  }
}
