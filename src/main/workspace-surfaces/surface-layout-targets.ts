import type Database from '../sqlite/sync-database'
import type { SurfaceKey, WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type {
  SurfaceCommandOutcome,
  SurfaceLayoutRequest,
  SurfaceTarget
} from '../../shared/workspace-surfaces/surface-command'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { rowKey, readSurface } from './surface-rows'

export function missingSurfaceTargets(
  request: SurfaceLayoutRequest,
  current: readonly WorkspaceSurface[]
): boolean {
  const { required, leaves } = surfaceLayoutTargetRequirements(request.command, current)
  const { command } = request
  const named = new Set(
    request.targets.map((target) =>
      rowKey({
        workspaceId: target.workspaceId ?? command.workspace,
        hostTabId: target.hostTabId
      })
    )
  )
  return (
    required.some((target) => !named.has(rowKey(target))) ||
    leaves.some(
      ({ hostTabId, leafId }) =>
        !request.targets.some(
          (target) =>
            target.hostTabId === hostTabId &&
            (target.workspaceId ?? command.workspace) === command.workspace &&
            target.leaf?.leafId === leafId &&
            target.leaf.runId !== undefined
        )
    )
  )
}

export function surfaceLayoutTargetRequirements(
  command: SurfaceLayoutRequest['command'],
  current: readonly WorkspaceSurface[]
): {
  required: Pick<SurfaceKey, 'workspaceId' | 'hostTabId'>[]
  leaves: { hostTabId: string; leafId: string }[]
} {
  const required: Pick<SurfaceKey, 'workspaceId' | 'hostTabId'>[] = []
  if ('tabId' in command && command.tabId) {
    required.push({ workspaceId: command.workspace, hostTabId: command.tabId })
  }
  if (command.type === 'movePaneToNewTab' && command.windowDetach?.tabId) {
    required.push({ workspaceId: command.workspace, hostTabId: command.windowDetach.tabId })
  }
  if (command.type === 'closeTabs') {
    required.push(
      ...command.tabIds.map((hostTabId) => ({ workspaceId: command.workspace, hostTabId }))
    )
  }
  if (command.type === 'applyDefaultTabs') {
    required.push(
      ...command.tabs.map(({ tabId }) => ({ workspaceId: command.workspace, hostTabId: tabId }))
    )
  }
  if (command.type === 'moveTabToWorkspace') {
    required.push(
      ...command.tabs.flatMap(({ tabId, newTabId }) => [
        { workspaceId: command.workspace, hostTabId: tabId },
        { workspaceId: command.toWorkspace, hostTabId: newTabId }
      ])
    )
  }
  if (
    command.type === 'startPane' ||
    command.type === 'restartPane' ||
    command.type === 'sleep' ||
    command.type === 'wake'
  ) {
    const paneKeys = 'paneKey' in command ? [command.paneKey] : command.paneKeys
    required.push(
      ...current
        .filter((surface) => {
          const content = surface.content
          return (
            content?.kind === 'terminal' &&
            (paneKeys === undefined ||
              paneKeys.some((key) => parsePaneKey(key)?.tabId === content.entityId))
          )
        })
        .map((surface) => ({ workspaceId: surface.workspaceId, hostTabId: surface.hostTabId }))
    )
  }
  const leaves: { hostTabId: string; leafId: string }[] = []
  if (
    command.type === 'splitPane' ||
    command.type === 'closePane' ||
    command.type === 'movePane' ||
    command.type === 'movePaneToNewTab' ||
    command.type === 'releasePaneTerminal' ||
    command.type === 'setChatPane'
  ) {
    if (command.leafId) {
      leaves.push({ hostTabId: command.tabId, leafId: command.leafId })
    }
    if (command.type === 'movePane') {
      leaves.push({ hostTabId: command.tabId, leafId: command.targetLeafId })
    }
  }
  if (
    command.type === 'startPane' ||
    command.type === 'restartPane' ||
    command.type === 'sleep' ||
    command.type === 'wake'
  ) {
    const keys = 'paneKey' in command ? [command.paneKey] : command.paneKeys
    for (const surface of current) {
      const content = surface.content
      if (content?.kind !== 'terminal') {
        continue
      }
      for (const leafId of Object.keys(content.leaves)) {
        if (
          !keys ||
          keys.some((key) => {
            const pane = parsePaneKey(key)
            return pane?.tabId === content.entityId && pane?.leafId === leafId
          })
        ) {
          leaves.push({ hostTabId: surface.hostTabId, leafId })
        }
      }
    }
  }
  return { required, leaves }
}

export function compareSurfaceTarget(
  db: Database.Database,
  scope: Pick<SurfaceKey, 'hostId' | 'workspaceId'>,
  target: SurfaceTarget
): Extract<SurfaceCommandOutcome, { status: 'conflict' }> | null {
  const current = readSurface(db, { ...scope, hostTabId: target.hostTabId })
  const expected = target.expected
  if (
    expected === null
      ? current !== null
      : current?.occurrence !== expected.occurrence ||
        (expected.revision !== undefined && current.revision !== expected.revision)
  ) {
    return { status: 'conflict', code: 'surface_changed', current }
  }
  if (target.leaf) {
    const leaf =
      current?.content?.kind === 'terminal' ? current.content.leaves[target.leaf.leafId] : undefined
    if (
      leaf?.occurrence !== target.leaf.occurrence ||
      (target.leaf.runId !== undefined && leaf.runId !== target.leaf.runId)
    ) {
      return { status: 'conflict', code: 'pane_changed', current }
    }
  }
  return null
}
