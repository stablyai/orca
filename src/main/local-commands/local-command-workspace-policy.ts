import {
  localCommandRefusal,
  type LocalCommandWorkspacePolicy
} from './local-command-request-checks'
import type { LocalCommandSettingsStore } from './local-command-settings-store'

const POLICY_TTL_MS = 30_000

/** Ownership and sharing per workspace (from the registry, cached briefly for display only), and
 *  the workspace names to show. Every decision re-reads the registry. */
export function createLocalCommandWorkspacePolicy(deps: {
  settings: LocalCommandSettingsStore
  supported: boolean
  readPolicy: (sandboxId: string) => Promise<LocalCommandWorkspacePolicy | null>
  now: () => number
}) {
  const cache = new Map<string, { at: number; value: LocalCommandWorkspacePolicy | null }>()
  const labels = new Map<string, string>()

  async function policyOf(
    sandboxId: string,
    fresh: boolean
  ): Promise<LocalCommandWorkspacePolicy | null> {
    const cached = cache.get(sandboxId)
    if (!fresh && cached && deps.now() - cached.at < POLICY_TTL_MS) {
      return cached.value
    }
    const value = await deps.readPolicy(sandboxId).catch(() => null)
    cache.set(sandboxId, { at: deps.now(), value })
    if (value?.title) {
      labels.set(sandboxId, value.title)
    }
    return value
  }

  return {
    policyOf,
    /** The last registry answer, for display; null until one arrives. */
    cached: (sandboxId: string) => cache.get(sandboxId)?.value ?? null,
    labelOf: (sandboxId: string): string => labels.get(sandboxId) ?? sandboxId,
    noteFallbackLabel(sandboxId: string, label: string): void {
      if (!labels.has(sandboxId)) {
        labels.set(sandboxId, label)
      }
    },
    /** Why this computer won't take a request now; null when it may ask the person. */
    async refusalOf(sandboxId: string): Promise<string | null> {
      const setting = deps.settings.workspace(sandboxId)
      if (!deps.supported || !setting?.enabled) {
        return localCommandRefusal(deps.supported, setting, null)
      }
      return localCommandRefusal(deps.supported, setting, await policyOf(sandboxId, true))
    }
  }
}
