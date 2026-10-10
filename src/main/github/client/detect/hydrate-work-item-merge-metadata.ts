import type { OwnerRepo } from '../../gh-utils'
import type { GhExecOptions } from './../github-exec-scope'
import { detectRepositoryMergeMetadata } from './repository-merge-metadata'
import type { MainWorkItem } from './../map/work-item-field-coercion'
export async function hydrateWorkItemRepositoryMergeMetadata(
  items: MainWorkItem[],
  ownerRepo: OwnerRepo | null,
  ghOptions: GhExecOptions,
  executionScope?: string
): Promise<MainWorkItem[]> {
  const hasPullRequest = items.some((item) => item.type === 'pr')
  if (!ownerRepo || !hasPullRequest) {
    return items
  }
  // Why: merge settings are repo-level, so one cached probe keeps Tasks rows accurate without per-PR GraphQL fan-out.
  const mergeMetadata = await detectRepositoryMergeMetadata(
    ownerRepo,
    undefined,
    ghOptions,
    executionScope
  )
  if (!mergeMetadata.mergeMethodSettings && mergeMetadata.autoMergeAllowed === null) {
    return items
  }
  return items.map((item) =>
    item.type === 'pr'
      ? {
          ...item,
          ...(mergeMetadata.autoMergeAllowed !== null
            ? { autoMergeAllowed: mergeMetadata.autoMergeAllowed }
            : {}),
          ...(mergeMetadata.mergeMethodSettings
            ? { mergeMethodSettings: mergeMetadata.mergeMethodSettings }
            : {})
        }
      : item
  )
}
