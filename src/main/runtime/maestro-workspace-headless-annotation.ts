import { createHash } from 'node:crypto'
import type {
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

export function createHeadlessMaestroAnnotationSnapshot(params: {
  existing: RuntimeMobileSessionTabsSnapshot | undefined
  worktreeId: string
  filePath: string
  relativePath: string
  title: string
  fallbackGroupId: string
}): { snapshot: RuntimeMobileSessionTabsSnapshot; tabId: string } {
  const digest = createHash('sha256').update(params.filePath).digest('hex').slice(0, 24)
  const tabId = `maestro-annotation-${digest}`
  const targetGroupId =
    params.existing?.activeGroupId ?? params.existing?.tabGroups?.[0]?.id ?? params.fallbackGroupId
  const tab: RuntimeMobileSessionMarkdownTab = {
    type: 'markdown',
    id: tabId,
    title: params.title,
    filePath: params.filePath,
    relativePath: params.relativePath,
    language: 'markdown',
    mode: 'edit',
    isDirty: false,
    isActive: false,
    sourceFileId: params.filePath,
    sourceFilePath: params.filePath,
    sourceRelativePath: params.relativePath,
    documentVersion: `headless:${digest}`
  }
  const tabs = [...(params.existing?.tabs ?? []).filter((candidate) => candidate.id !== tabId), tab]
  const existingGroups = params.existing?.tabGroups ?? []
  const tabGroups: RuntimeMobileSessionTabGroup[] = existingGroups.some(
    (group) => group.id === targetGroupId
  )
    ? existingGroups.map((group) =>
        group.id === targetGroupId
          ? { ...group, tabOrder: [...group.tabOrder.filter((id) => id !== tabId), tabId] }
          : group
      )
    : [...existingGroups, { id: targetGroupId, activeTabId: null, tabOrder: [tabId] }]

  return {
    tabId,
    snapshot: {
      worktree: params.worktreeId,
      publicationEpoch:
        params.existing?.publicationEpoch ?? `headless:maestro-annotation:${digest}`,
      snapshotVersion: (params.existing?.snapshotVersion ?? 0) + 1,
      activeGroupId: params.existing?.activeGroupId ?? null,
      activeTabId: params.existing?.activeTabId ?? null,
      activeTabType: params.existing?.activeTabType ?? null,
      tabGroups,
      ...(params.existing?.tabGroupLayout
        ? { tabGroupLayout: params.existing.tabGroupLayout }
        : {}),
      tabs
    }
  }
}
