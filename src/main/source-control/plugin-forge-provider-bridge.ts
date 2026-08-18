import type { ForgeProvider, ForgeProviderRepositoryContext } from './forge-provider'
import { readRemoteUrl } from '../git/remote-url-probe'

// A minimal host parser for plugin provider remote matching.
/**
 * Extract the host (hostname, lowercased) from any git remote URL form:
 * https://host[:port]/path, ssh://git@host[:port]/path, git@host:path.
 */
export function hostFromRemoteUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/^git\+/, '')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase()
    } catch {
      return null
    }
  }
  const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):/)
  return scpLike ? scpLike[1]!.toLowerCase() : null
}

export type PluginForgeProviderRegistryHandle = {
  getByProviderId(id: string): ForgeProvider | null
  findByHost(host: string): { provider: ForgeProvider } | null
}

/** Batch-set all three plugin forge provider resolvers from a registry handle. */
export function bindPluginForgeProviderResolvers(
  registry: PluginForgeProviderRegistryHandle
): void {
  setPluginProviderByIdResolver((providerId) => registry.getByProviderId(providerId))
  setPluginProviderByHostResolver((host) => registry.findByHost(host)?.provider ?? null)
  setPluginForgeProviderResolver(async (context) => {
    const remoteUrl = await readRemoteUrl(
      {
        repoPath: context.repoPath,
        connectionId: context.connectionId ?? null
      },
      'origin'
    )
    if (!remoteUrl) {
      return null
    }
    const host = hostFromRemoteUrl(remoteUrl)
    if (!host) {
      return null
    }
    const entry = registry.findByHost(host)
    if (!entry) {
      return null
    }
    const resolved = await entry.provider.resolveRepository(context)
    return resolved ? entry.provider : null
  })
}
let pluginProviderById: (id: string) => ForgeProvider | null = () => null

export function getPluginProviderById(id: string): ForgeProvider | null {
  return pluginProviderById(id)
}

export function setPluginProviderByIdResolver(
  resolver: (id: string) => ForgeProvider | null
): void {
  pluginProviderById = resolver
}

let pluginProviderByHost: (host: string) => ForgeProvider | null = () => null

export function getPluginProviderByHost(host: string): ForgeProvider | null {
  return pluginProviderByHost(host)
}

export function setPluginProviderByHostResolver(
  resolver: (host: string) => ForgeProvider | null
): void {
  pluginProviderByHost = resolver
}

let pluginForgeProviderResolver: (
  context: ForgeProviderRepositoryContext
) => Promise<ForgeProvider | null> = async () => null

export async function resolvePluginForgeProvider(
  context: ForgeProviderRepositoryContext
): Promise<ForgeProvider | null> {
  return pluginForgeProviderResolver(context)
}

export function setPluginForgeProviderResolver(
  resolver: (context: ForgeProviderRepositoryContext) => Promise<ForgeProvider | null>
): void {
  pluginForgeProviderResolver = resolver
}
