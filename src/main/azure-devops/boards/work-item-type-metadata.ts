import type {
  AzureDevOpsStateCategory,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../shared/azure-devops/boards-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'

type RawType = {
  name?: string
  color?: string | null
  icon?: { id?: string | null; url?: string | null } | null
  states?: { name?: string; color?: string | null; category?: string }[]
}

const CATEGORIES = new Set<string>(['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed'])

function isStateCategory(value: string | undefined): value is AzureDevOpsStateCategory {
  return value !== undefined && CATEGORIES.has(value)
}

export function normalizeAzureDevOpsColor(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const hex = value.replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null
}

function normalizeIconUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * State names that every one of the given types which defines them puts in the
 * `Removed` category, so a query can exclude them.
 */
export function removedStateNamesForTypes(
  typeNames: Iterable<string>,
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
): string[] {
  const removed = new Set<string>()
  const live = new Set<string>()
  for (const typeName of typeNames) {
    for (const state of workItemTypes[typeName]?.states ?? []) {
      ;(state.category === 'Removed' ? removed : live).add(state.name)
    }
  }
  // Why: the workflow is per type, so a name another type uses for active work must stay in the query.
  return [...removed].filter((name) => !live.has(name))
}

export async function getAzureDevOpsWorkItemTypes(
  repo: AzureDevOpsRepoRef
): Promise<Record<string, AzureDevOpsWorkItemTypeMetadata>> {
  const bases = resolveAzureDevOpsApiBases(repo)
  const raw = await requestAzureDevOpsJsonAtBase<{ value?: RawType[] }>(
    bases.project,
    '/_apis/wit/workitemtypes'
  )
  const result: Record<string, AzureDevOpsWorkItemTypeMetadata> = {}
  for (const type of raw?.value ?? []) {
    if (!type.name) {
      continue
    }
    result[type.name] = {
      name: type.name,
      color: normalizeAzureDevOpsColor(type.color),
      iconId: type.icon?.id ?? null,
      iconUrl: normalizeIconUrl(type.icon?.url),
      states: (type.states ?? [])
        .filter((s): s is { name: string; color?: string | null; category?: string } =>
          Boolean(s.name)
        )
        .map((s) => ({
          name: s.name,
          color: normalizeAzureDevOpsColor(s.color),
          category: isStateCategory(s.category) ? s.category : 'Proposed'
        }))
    }
  }
  return result
}
