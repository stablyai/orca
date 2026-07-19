import { sanitizeWslHookInstanceKey } from '../../shared/wsl-hook-relay-contract'

export class WslHookRelayInstanceKeyResolver {
  private cached: string | null = null

  resolve(coords: Record<string, string>, configuredKey: () => string | null): string | null {
    if (this.cached) {
      return this.cached
    }
    const port = Number(coords.ORCA_AGENT_HOOK_PORT ?? '')
    if (!Number.isInteger(port) || port <= 0 || !coords.ORCA_AGENT_HOOK_TOKEN) {
      return null
    }
    // Why: cache the fallback too so terminal setup and the async relay launch
    // cannot derive different endpoint namespaces during the same spawn.
    this.cached = sanitizeWslHookInstanceKey(configuredKey() ?? undefined) ?? `port${port}`
    return this.cached
  }
}
