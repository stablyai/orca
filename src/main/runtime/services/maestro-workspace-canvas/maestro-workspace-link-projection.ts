import { createHash } from 'node:crypto'
import type {
  WorkspaceAutomaticLink,
  WorkspaceSurface,
  WorkspaceSurfaceSnapshot
} from '../../../../shared/maestro-workspace-canvas'
import type {
  RuntimeMaestroWorkspaceCanvasScope,
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import { getMaestroProjection } from '../../orchestration/db/maestro/maestro-projection-store'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { MaestroTerminalLease } from '../../../../shared/maestro-terminal-lease'
import {
  joinMaestroWorkspaceBrowserReceipts,
  joinMaestroWorkspaceParentChildReceipts,
  latestMaestroWorkspaceReceiptTimestamp,
  type MaestroWorkspaceLinkReceiptEndpoint
} from './maestro-workspace-link-receipt-join'

type LinkProjection = Pick<WorkspaceSurfaceSnapshot, 'automatic_links' | 'suggested_links'>

type AutomaticLinkKind = Pick<
  WorkspaceAutomaticLink,
  'link_type' | 'authority_kind' | 'explanation_code'
>

const AUTOMATIC_EDGE_KINDS: Readonly<Partial<Record<string, AutomaticLinkKind>>> = {
  executes: {
    link_type: 'executes',
    authority_kind: 'execution-receipt',
    explanation_code: 'executes-resource'
  },
  produces: {
    link_type: 'produces',
    authority_kind: 'evidence-production-receipt',
    explanation_code: 'produced-evidence'
  },
  spawned_by: {
    link_type: 'parent-child',
    authority_kind: 'parent-child-receipt',
    explanation_code: 'parent-child'
  }
}

function terminalReceiptIdentity(
  database: OrchestrationDb,
  scope: RuntimeMaestroWorkspaceCanvasScope,
  tab: RuntimeMobileSessionClientTab
): { identifiers: Set<string>; lease: MaestroTerminalLease } | null {
  if (tab.type !== 'terminal' || tab.status !== 'ready') {
    return null
  }
  const lease = database.getMaestroTerminalLeaseByHandle(tab.terminal)
  if (
    !lease ||
    lease.executionHostId !== scope.execution_host_id ||
    lease.workspaceKey !== scope.workspace_key ||
    !lease.runId ||
    !lease.launchProfile.agent
  ) {
    return null
  }
  return {
    lease,
    identifiers: new Set(
      [
        tab.terminal,
        tab.ptyId,
        tab.parentTabId,
        lease.id,
        lease.workerTerminalResourceId,
        lease.terminalHandle,
        lease.tabId
      ].filter((value): value is string => Boolean(value))
    )
  }
}

function bindGraphNodesToSurfaces(params: {
  database: OrchestrationDb
  scope: RuntimeMaestroWorkspaceCanvasScope
  session: RuntimeMobileSessionTabsResult
  surfaces: Record<string, WorkspaceSurface>
  projection: NonNullable<ReturnType<typeof getMaestroProjection>>
}): Map<string, MaestroWorkspaceLinkReceiptEndpoint> {
  const candidates = new Map<string, Map<string, MaestroWorkspaceLinkReceiptEndpoint>>()
  const add = (nodeId: string, endpoint: MaestroWorkspaceLinkReceiptEndpoint): void => {
    const existing =
      candidates.get(nodeId) ?? new Map<string, MaestroWorkspaceLinkReceiptEndpoint>()
    existing.set(endpoint.surfaceKey, endpoint)
    candidates.set(nodeId, existing)
  }
  const surfaceKeysByTabId = new Map<string, Set<string>>()
  for (const [surfaceKey, surface] of Object.entries(params.surfaces)) {
    if (
      surface.binding.kind !== 'terminal' ||
      surface.id.execution_host_id !== params.scope.execution_host_id ||
      surface.id.workspace_key !== params.scope.workspace_key ||
      surface.binding.terminal_tab_id !== surface.id.unified_tab_id
    ) {
      continue
    }
    const surfaceKeys = surfaceKeysByTabId.get(surface.id.unified_tab_id) ?? new Set<string>()
    surfaceKeys.add(surfaceKey)
    surfaceKeysByTabId.set(surface.id.unified_tab_id, surfaceKeys)
  }
  for (const tab of params.session.tabs) {
    if (tab.type !== 'terminal') {
      continue
    }
    const surfaceKeys = surfaceKeysByTabId.get(tab.parentTabId)
    if (surfaceKeys?.size !== 1) {
      continue
    }
    const surfaceKey = [...surfaceKeys][0]!
    const identity = terminalReceiptIdentity(params.database, params.scope, tab)
    if (!identity || identity.lease.runId !== params.projection.runId) {
      continue
    }
    for (const node of params.projection.nodes) {
      const sameScope =
        node.executionHostId === params.scope.execution_host_id &&
        node.workspaceKey === params.scope.workspace_key
      const sameTask = !node.taskId || node.taskId === identity.lease.taskId
      const sameAttempt = !node.attemptId || node.attemptId === identity.lease.attemptId
      const terminalReceiptMatches =
        node.type === 'terminal-receipt' &&
        Boolean(node.terminalId && identity.identifiers.has(node.terminalId))
      const attemptMatches =
        node.type === 'attempt' &&
        Boolean(node.attemptId && identity.lease.attemptId === node.attemptId) &&
        (!node.terminalId || identity.identifiers.has(node.terminalId))
      const taskMatches =
        node.type === 'task' && Boolean(node.taskId && identity.lease.taskId === node.taskId)
      if (
        sameScope &&
        sameTask &&
        sameAttempt &&
        (terminalReceiptMatches || attemptMatches || taskMatches)
      ) {
        add(node.id, { surfaceKey, receipt: identity.lease, node })
      }
    }
  }
  for (const node of params.projection.nodes) {
    const receipt = node.browserSurface
    if (
      !receipt?.browser_page_id ||
      receipt.execution_host_id !== params.scope.execution_host_id ||
      receipt.workspace_key !== params.scope.workspace_key
    ) {
      continue
    }
    const matches = Object.entries(params.surfaces).filter(
      ([, surface]) =>
        surface.binding.kind === 'browser' &&
        surface.id.execution_host_id === params.scope.execution_host_id &&
        surface.id.workspace_key === params.scope.workspace_key &&
        surface.binding.browser_page_id === receipt.browser_page_id
    )
    for (const [surfaceKey] of matches) {
      add(node.id, { surfaceKey, receipt, node })
    }
  }
  return new Map(
    [...candidates.entries()].flatMap(([nodeId, endpoints]) =>
      endpoints.size === 1 ? [[nodeId, [...endpoints.values()][0]!] as const] : []
    )
  )
}

function automaticLinks(params: {
  database: OrchestrationDb
  scope: RuntimeMaestroWorkspaceCanvasScope
  session: RuntimeMobileSessionTabsResult
  surfaces: Record<string, WorkspaceSurface>
}): WorkspaceAutomaticLink[] {
  const projection = getMaestroProjection.call(params.database, params.scope)
  if (!projection) {
    return []
  }
  const nodeBindings = bindGraphNodesToSurfaces({ ...params, projection })
  return projection.edges.flatMap((edge) => {
    const kind = AUTOMATIC_EDGE_KINDS[edge.type]
    const source = nodeBindings.get(edge.source_id)
    const target = nodeBindings.get(edge.target_id)
    if (!kind || !source || !target || source.surfaceKey === target.surfaceKey) {
      return []
    }
    const receiptTimestamps =
      edge.type === 'spawned_by'
        ? (() => {
            const receipts = joinMaestroWorkspaceParentChildReceipts(
              source,
              target,
              projection.runId
            )
            return receipts ? [receipts.child.updatedAt, receipts.parent.updatedAt] : null
          })()
        : (() => {
            const receipts = joinMaestroWorkspaceBrowserReceipts(source, target)
            return receipts ? [receipts.terminal.updatedAt, receipts.browser.updated_at] : null
          })()
    if (!receiptTimestamps) {
      return []
    }
    const observedAt = latestMaestroWorkspaceReceiptTimestamp(receiptTimestamps)
    return [
      {
        id: `automatic-${createHash('sha256')
          .update(`${projection.runId}\0${edge.id}`)
          .digest('hex')
          .slice(0, 24)}`,
        source_surface_key: source.surfaceKey,
        target_surface_key: target.surfaceKey,
        ...kind,
        authority_id: `${projection.runId}:${edge.id}`,
        authority_revision: projection.revision,
        observed_at: observedAt
      }
    ]
  })
}

export function projectMaestroWorkspaceLinks(params: {
  database: OrchestrationDb
  scope: RuntimeMaestroWorkspaceCanvasScope
  session: RuntimeMobileSessionTabsResult
  surfaces: Record<string, WorkspaceSurface>
}): LinkProjection {
  const automatic = automaticLinks(params)
  return {
    automatic_links: automatic,
    suggested_links: []
  }
}
