import { isDeepStrictEqual } from 'node:util'
import type Database from '../sqlite/sync-database'
import { applyLayoutCommand } from '../../shared/workspace-layout/workspace-layout-commands'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import { projectSurfaceWorkspace } from '../../shared/workspace-surfaces/surface-layout'
import {
  surfaceContentOf,
  type WorkspaceSurface
} from '../../shared/workspace-surfaces/surface-content'
import type {
  SurfaceLayoutRequest,
  SurfaceLayoutView,
  SurfaceCommandOutcome
} from '../../shared/workspace-surfaces/surface-command'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { missingSurfaceTargets, compareSurfaceTarget } from './surface-layout-targets'
import { existingLayoutCreateOutcome } from '../persistence/terminal-topology/terminal-pane-admission'
import { runTargetOf } from '../../shared/workspace-surfaces/surface-allocation'
import { writeAllocation } from './surface-allocation-rows'
import { conflictingSurfaceIdentity } from './surface-identities'
import {
  rowKey,
  readWorkspace,
  withRetiredChatViews,
  writeChanges,
  advanceDomain,
  domainRevision
} from './surface-rows'

/** The profile owner supplies the admitted transaction, including its command receipt. */
export function applySurfaceLayout(
  db: Database.Database,
  request: SurfaceLayoutRequest,
  view: SurfaceLayoutView,
  mintId: () => string,
  present?: (model: WorkspaceLayoutModel) => void,
  rawClosed?: (tabId: string, workspaceId: string) => boolean
): SurfaceCommandOutcome {
  const { hostId, command } = request
  const creates =
    command.type === 'createTerminalTab'
      ? command.tabId
        ? [command.tabId]
        : []
      : command.type === 'applyDefaultTabs'
        ? command.tabs.map((tab) => tab.tabId)
        : []
  if (creates.some((tabId) => rawClosed?.(tabId, command.workspace))) {
    return { status: 'conflict', code: 'tab_closed', current: null }
  }
  const scopes =
    command.type === 'moveTabToWorkspace'
      ? [...new Set([command.workspace, command.toWorkspace])]
      : [command.workspace]
  const before = scopes.flatMap((workspaceId) => readWorkspace(db, hostId, workspaceId))
  const missing = missingSurfaceTargets(request, before)
  if (missing || view.model.hostId !== hostId) {
    return { status: 'conflict', code: 'surface_expectation_required', current: null }
  }
  for (const target of request.targets) {
    const conflict = compareSurfaceTarget(
      db,
      { hostId, workspaceId: target.workspaceId ?? command.workspace },
      target
    )
    if (conflict) {
      return conflict
    }
  }
  const affected = new Map(
    scopes.map((workspaceId) => [
      workspaceId,
      before.filter((surface) => surface.workspaceId === workspaceId)
    ])
  )
  const workspaceIds = new Set([...Object.keys(view.model.workspaces), ...scopes])
  const model: WorkspaceLayoutModel = {
    ...view.model,
    workspaces: Object.fromEntries(
      [...workspaceIds].map((workspaceId) => {
        const workspace = view.model.workspaces[workspaceId]
        return [
          workspaceId,
          affected.has(workspaceId)
            ? projectSurfaceWorkspace(
                workspaceId,
                workspace,
                affected.get(workspaceId)!,
                view.chatVerified
              )
            : {
                ...workspace!,
                tabs: workspace!.tabs.filter(
                  (tab) => tab.kind !== 'terminal' && tab.kind !== 'agent-session'
                )
              }
        ]
      })
    )
  }
  const existing = existingLayoutCreateOutcome(model, command)
  if (existing) {
    return existing.ok
      ? {
          status: 'accepted',
          revision: domainRevision(db, hostId),
          surfaces: [],
          result: existing.result,
          effects: { startPaneKeys: [], stopPtyIds: [] }
        }
      : { status: 'conflict', code: existing.code, current: null }
  }
  if (
    command.type === 'openAgentSessionTab' &&
    command.tabId &&
    Object.values(model.workspaces).some((workspace) =>
      workspace.tabs.some(
        (tab) =>
          tab.id === command.tabId &&
          (tab.kind !== 'agent-session' || tab.entityId !== command.sessionId)
      )
    )
  ) {
    return { status: 'conflict', code: 'tab_exists', current: null }
  }
  const applied = applyLayoutCommand(model, command, view.context)
  if (!applied.ok) {
    return { status: 'conflict', code: applied.code, current: null }
  }
  const previous = new Map(before.map((surface) => [rowKey(surface), surface]))
  const movedLeaves = new Map(
    before.flatMap((surface) =>
      surface.content?.kind === 'terminal' ? Object.entries(surface.content.leaves) : []
    )
  )
  const newRuns = new Set<string>(
    applied.effects.startPaneKeys.flatMap((key) => {
      const pane = parsePaneKey(key)
      return pane ? [pane.leafId] : []
    })
  )
  const retained = new Set<string>()
  const changed: WorkspaceSurface[] = []
  for (const workspaceId of scopes) {
    const workspace = applied.model.workspaces[workspaceId]
    for (const tab of workspace?.tabs ?? []) {
      if (tab.kind !== 'terminal' && tab.kind !== 'agent-session') {
        continue
      }
      const key = { workspaceId, hostTabId: tab.id }
      retained.add(rowKey(key))
      const prior = previous.get(rowKey(key))
      if (
        tab.kind === 'agent-session' &&
        view.chatVerified === false &&
        !prior &&
        view.model.workspaces[workspaceId]?.tabs.some(
          (candidate) =>
            candidate.kind === 'agent-session' &&
            candidate.id === tab.id &&
            candidate.entityId === tab.entityId
        )
      ) {
        continue
      }
      const content = surfaceContentOf(
        tab,
        workspace!,
        prior?.content,
        mintId,
        movedLeaves,
        newRuns
      )
      if (prior && isDeepStrictEqual(prior.content, content)) {
        continue
      }
      const next: WorkspaceSurface = {
        hostId,
        workspaceId,
        hostTabId: tab.id,
        occurrence: prior?.content ? prior.occurrence : mintId(),
        revision: (prior?.revision ?? 0) + 1,
        createdAt: prior?.createdAt ?? tab.createdAt,
        content
      }
      changed.push(next)
    }
  }
  for (const prior of before) {
    if (prior.content && !retained.has(rowKey(prior))) {
      const closed = {
        ...prior,
        occurrence: mintId(),
        revision: prior.revision + 1,
        content: null
      }
      changed.push(closed)
    }
  }
  const committed = withRetiredChatViews(db, changed, mintId)
  const identityConflict = conflictingSurfaceIdentity(db, committed)
  if (identityConflict) {
    return identityConflict
  }
  writeChanges(db, committed)
  for (const surface of committed) {
    if (surface.content?.kind !== 'terminal') {
      continue
    }
    for (const [leafId, leaf] of Object.entries(surface.content.leaves)) {
      if (newRuns.has(leafId)) {
        writeAllocation(db, {
          allocationId: leaf.runId,
          target: runTargetOf(surface, leafId)!,
          resourceId: null,
          executorId: null,
          resource: null,
          decision: 'pending',
          expiresAt: request.expiresAt
        })
      }
    }
  }
  present?.({
    ...applied.model,
    workspaces: {
      ...view.model.workspaces,
      ...Object.fromEntries(
        scopes.map((workspaceId) => [workspaceId, applied.model.workspaces[workspaceId]!])
      )
    }
  })
  return {
    status: 'accepted',
    revision: committed.length ? advanceDomain(db, hostId) : domainRevision(db, hostId),
    surfaces: committed,
    result: applied.result,
    effects: applied.effects
  }
}
