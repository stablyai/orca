import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceLineage } from '../../../shared/worktree/lineage-types'
import { normalizeFeatureInteractions } from '../../../shared/feature-interactions'
import { normalizeContextualTourIds } from '../../../shared/contextual-tours'
import { isWorkspaceKey } from '../../../shared/workspace-scope'

export function mergeFeatureInteractions(
  current: PersistedState['ui']['featureInteractions'],
  incoming: PersistedState['ui']['featureInteractions']
): PersistedState['ui']['featureInteractions'] {
  const currentNormalized = normalizeFeatureInteractions(current)
  const incomingNormalized = normalizeFeatureInteractions(incoming)
  const merged = { ...currentNormalized }
  for (const [id, incomingRecord] of Object.entries(incomingNormalized)) {
    const currentRecord = currentNormalized[id as keyof typeof currentNormalized]
    merged[id as keyof typeof merged] = currentRecord
      ? {
          firstInteractedAt: Math.min(
            currentRecord.firstInteractedAt,
            incomingRecord.firstInteractedAt
          ),
          interactionCount: Math.max(
            currentRecord.interactionCount,
            incomingRecord.interactionCount
          )
        }
      : incomingRecord
  }
  return merged
}

export function mergeContextualTourSeenIds(
  current: PersistedState['ui']['contextualToursSeenIds'],
  incoming: PersistedState['ui']['contextualToursSeenIds']
): PersistedState['ui']['contextualToursSeenIds'] {
  const merged = new Set(normalizeContextualTourIds(current))
  for (const id of normalizeContextualTourIds(incoming)) {
    merged.add(id)
  }
  return [...merged]
}

export function stripMainOwnedTelemetryMarkerFromUI(
  value: Partial<PersistedState['ui']> | undefined
): Partial<PersistedState['ui']> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const { featureInteractionTelemetryBuckets: _reserved, ...ui } = value as Partial<
    PersistedState['ui']
  > & {
    featureInteractionTelemetryBuckets?: unknown
  }
  void _reserved
  return ui
}

export function normalizeWorkspaceLineageByChildKey(
  value: unknown
): Record<WorkspaceKey, WorkspaceLineage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const normalized: Record<WorkspaceKey, WorkspaceLineage> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isWorkspaceKey(key) || !entry || typeof entry !== 'object') {
      continue
    }
    const lineage = entry as Partial<WorkspaceLineage>
    const childWorkspaceKey =
      typeof lineage.childWorkspaceKey === 'string' && isWorkspaceKey(lineage.childWorkspaceKey)
        ? lineage.childWorkspaceKey
        : key
    const parentWorkspaceKey = lineage.parentWorkspaceKey
    if (
      !isWorkspaceKey(childWorkspaceKey) ||
      typeof parentWorkspaceKey !== 'string' ||
      !isWorkspaceKey(parentWorkspaceKey) ||
      childWorkspaceKey !== key ||
      childWorkspaceKey === parentWorkspaceKey
    ) {
      continue
    }
    normalized[childWorkspaceKey] = {
      childWorkspaceKey,
      childInstanceId: lineage.childInstanceId ?? null,
      parentWorkspaceKey,
      parentInstanceId: lineage.parentInstanceId ?? null,
      origin: lineage.origin ?? 'cli',
      capture: lineage.capture ?? { source: 'manual-action', confidence: 'inferred' },
      ...(lineage.taskId ? { taskId: lineage.taskId } : {}),
      ...(lineage.orchestrationRunId ? { orchestrationRunId: lineage.orchestrationRunId } : {}),
      ...(lineage.coordinatorHandle ? { coordinatorHandle: lineage.coordinatorHandle } : {}),
      ...(lineage.createdByTerminalHandle
        ? { createdByTerminalHandle: lineage.createdByTerminalHandle }
        : {}),
      createdAt: Number.isFinite(lineage.createdAt) ? Number(lineage.createdAt) : Date.now()
    }
  }
  return normalized
}
