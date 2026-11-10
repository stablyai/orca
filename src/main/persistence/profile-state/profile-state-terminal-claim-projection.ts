import { parseExecutionHostId } from '../../../shared/execution-host'
import {
  LegacyTerminalIdentityClaims,
  type LegacyClaimState,
  type LegacyClaimSession,
  type LegacyClaimLayout
} from '../loading-store/legacy-terminal-identity-claims'
import { isRecord } from './profile-state-document-validation'

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Invalid terminal claim record')
  }
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid terminal claim identity')
  }
  return value
}
function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : text(value)
}
function rows(value: unknown): unknown[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid terminal claim rows')
  }
  return value
}
function host(value: Record<string, unknown>) {
  if (value.orcadRetained !== undefined && !isRecord(value.orcadRetained)) {
    throw new Error('Invalid retained host')
  }
  return {
    connectionId: optionalText(value.connectionId),
    executionHostId: optionalText(value.executionHostId),
    orcadRetained: value.orcadRetained
  }
}
function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value === undefined ? {} : record(value)).map(([key, id]) => [key, text(id)])
  )
}
function session(value: unknown): LegacyClaimSession {
  const input = value === undefined ? {} : record(value)
  const tabsByWorktree = Object.fromEntries(
    Object.entries(input.tabsByWorktree === undefined ? {} : record(input.tabsByWorktree)).map(
      ([workspace, tabs]) => {
        if (!Array.isArray(tabs)) {
          throw new Error('Invalid terminal tabs')
        }
        return [
          workspace,
          tabs.map((tab: unknown) => {
            const row = record(tab)
            return { id: text(row.id), ptyId: optionalText(row.ptyId) }
          })
        ]
      }
    )
  )
  const terminalLayoutsByTabId: Record<string, LegacyClaimLayout> = Object.fromEntries(
    Object.entries(
      input.terminalLayoutsByTabId === undefined ? {} : record(input.terminalLayoutsByTabId)
    ).map(([tab, value]) => {
      const layout = record(value)
      const root = layout.root === undefined || layout.root === null ? null : record(layout.root)
      return [
        tab,
        {
          root: root ? { type: text(root.type), leafId: optionalText(root.leafId) } : null,
          ptyIdsByLeafId: strings(layout.ptyIdsByLeafId)
        }
      ]
    })
  )
  return {
    tabsByWorktree,
    terminalLayoutsByTabId,
    remoteSessionIdsByTabId: strings(input.remoteSessionIdsByTabId)
  }
}

/** Only negative numeric facts leave this reader; unknown host ownership still competes. */
export function projectProfileTerminalClaims(input: ReadonlyMap<string, unknown>): string[] {
  const state: LegacyClaimState = {
    repos: rows(input.get('repos')).map((value) => {
      const repo = record(value)
      return {
        id: text(repo.id),
        path: optionalText(repo.path),
        projectGroupId: optionalText(repo.projectGroupId),
        ...host(repo)
      }
    }),
    folderWorkspaces: rows(input.get('folderWorkspaces')).map((value) => {
      const folder = record(value)
      return {
        id: text(folder.id),
        folderPath: text(folder.folderPath),
        projectGroupId: text(folder.projectGroupId),
        ...host(folder)
      }
    }),
    projectGroups: rows(input.get('projectGroups')).map((value) => {
      const group = record(value)
      return {
        id: text(group.id),
        parentGroupId: optionalText(group.parentGroupId) ?? null,
        ...host(group)
      }
    }),
    workspaceSession: session(input.get('workspaceSession'))
  }
  const ids = new Set(new LegacyTerminalIdentityClaims(state).potentiallyLocalNumericIds())
  const partitions = input.get('workspaceSessionsByHostId')
  for (const [hostId, value] of Object.entries(
    partitions === undefined ? {} : record(partitions)
  )) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed && parsed.kind !== 'local') {
      continue
    }
    for (const id of new LegacyTerminalIdentityClaims({
      ...state,
      workspaceSession: session(value)
    }).potentiallyLocalNumericIds()) {
      ids.add(id)
    }
  }
  return [...ids]
}
