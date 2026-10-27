// Seed new Claude chats from finished host listings: replace unlisted models with default/first and nearest supported effort; never replace saved/running chat choices.

import { finishedListingIds } from '../../../shared/structured-agent-session-options'
import type { AgentModelCatalogService } from '../../native-chat/agent-model-catalog/agent-model-catalog-service'

const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** `previous` if `supported` offers it, else the nearest offered level (the higher on a tie). */
export function nearestAgentEffort(
  previous: string,
  supported: readonly string[]
): string | undefined {
  const rank = (level: string): number => EFFORT_RANK.indexOf(level)
  const distance = (level: string): number => Math.abs(rank(level) - rank(previous))
  if (supported.includes(previous)) {
    return previous
  }
  if (rank(previous) === -1) {
    return undefined
  }
  return supported
    .filter((level) => rank(level) !== -1)
    .sort((a, b) => distance(a) - distance(b) || rank(b) - rank(a))[0]
}

/** Read saved catalogs only for Claude seeds naming a model; unreadable/unfinished catalogs preserve the seed. */
export async function structuredLaunchSeedOnSavedListing(
  host: { deps: { modelCatalog?: Pick<AgentModelCatalogService, 'read'> } },
  agent: string,
  seed: Readonly<Record<string, string>> | undefined,
  workspacePath: () => Promise<string | null>
): Promise<Readonly<Record<string, string>> | undefined> {
  const catalogs = agent === 'claude' && seed?.model ? host.deps.modelCatalog : undefined
  if (!seed?.model || !catalogs) {
    return seed
  }
  const catalog = await workspacePath()
    .catch(() => null)
    .then((path) =>
      catalogs.read({ agent, workspacePath: path, savedOnly: true, verifiedOnly: true })
    )
    .catch(() => null)
  const listed = catalog ? finishedListingIds(catalog) : undefined
  if (!catalog || catalog.origin === 'unknown' || !listed || listed.includes(seed.model)) {
    return seed
  }
  const target = catalog.models.find((row) => row.isDefault) ?? catalog.models[0]
  if (!target) {
    return seed
  }
  const { effort: remembered, ...rest } = seed
  const effort = remembered
    ? nearestAgentEffort(
        remembered,
        target.efforts.map((choice) => choice.value)
      )
    : undefined
  return { ...rest, model: target.id, ...(effort ? { effort } : {}) }
}
