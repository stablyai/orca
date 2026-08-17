import { createHash } from 'node:crypto'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { HerdrHostTransport } from './herdr-runtime-contract'
import { HerdrRuntimeError, unwrapHerdrResponse } from './herdr-runtime-contract'

export const ORCA_BINDING_TOKEN = 'orca_binding'

// Stock herdr report-metadata requires a --source to attribute the metadata.
export const ORCA_METADATA_SOURCE = 'orca'

export function findUniqueHerdrMatch<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  description: string
): T | null {
  const matches = items.filter(predicate)
  if (matches.length > 1) {
    throw new HerdrRuntimeError(
      'herdr_binding_ambiguous',
      `Multiple ${description} found — Orca will not guess`
    )
  }
  if (matches.length === 0) {
    return null
  }
  return matches[0]
}

export type ReclaimOrcaPaneBindingOptions = {
  preferredPaneId?: string
  workspaceId?: string
}

type ReclaimableHerdrPane = {
  pane_id: string
  workspace_id?: string
  tokens?: Record<string, string>
}

// Stock pane.report_metadata is not exclusive. When two panes carry the same
// orca_binding, keep one owner and persist-clear the rest.
export async function reclaimExclusiveOrcaPaneBinding<T extends ReclaimableHerdrPane>(
  transport: HerdrHostTransport,
  sessionName: string,
  snapshot: { panes: T[] },
  binding: string,
  options: ReclaimOrcaPaneBindingOptions = {}
): Promise<T | null> {
  const matches = snapshot.panes.filter((pane) => pane.tokens?.[ORCA_BINDING_TOKEN] === binding)
  if (matches.length === 0) {
    return null
  }
  const winner = pickExclusiveOrcaPane(matches, options)
  for (const extra of matches) {
    if (extra.pane_id === winner.pane_id) {
      continue
    }
    await unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.report_metadata', {
        pane_id: extra.pane_id,
        source: ORCA_METADATA_SOURCE,
        tokens: { [ORCA_BINDING_TOKEN]: null }
      })
    )
    if (extra.tokens) {
      delete extra.tokens[ORCA_BINDING_TOKEN]
    }
  }
  return winner
}

function pickExclusiveOrcaPane<T extends ReclaimableHerdrPane>(
  matches: readonly T[],
  options: ReclaimOrcaPaneBindingOptions
): T {
  if (options.preferredPaneId) {
    const preferred = matches.find((pane) => pane.pane_id === options.preferredPaneId)
    if (preferred) {
      return preferred
    }
  }
  const scoped = options.workspaceId
    ? matches.filter((pane) => pane.workspace_id === options.workspaceId)
    : matches
  const pool = scoped.length > 0 ? scoped : matches
  return [...pool].sort((left, right) => left.pane_id.localeCompare(right.pane_id))[0]
}

export function orcaPaneBinding(projectId: string, leafId: string): string {
  return createHash('sha256').update(`orca:binding:${projectId}:${leafId}`).digest('hex')
}

export function orcaWorkspaceBinding(
  projectId: string,
  worktree: { id: string; instanceId?: string; path?: string; displayName?: string }
): string {
  return createHash('sha256').update(`orca:binding:${projectId}:${worktree.id}`).digest('hex')
}

export function paneBindingMapKey(sessionName: string, binding: string): string {
  return `${sessionName}:${binding}`
}

export function terminalLeafIds(snapshot: {
  panes: { leafId?: string; pane_id: string }[]
}): string[] {
  return snapshot.panes.map((p) => p.leafId ?? p.pane_id)
}

export function collectLeafIds(node: TerminalPaneLayoutNode): string[] {
  const leafIds: string[] = []
  function collect(n: TerminalPaneLayoutNode): void {
    if (n.type === 'leaf') {
      leafIds.push(n.leafId)
    } else {
      collect(n.first)
      collect(n.second)
    }
  }
  collect(node)
  return leafIds
}

export function recoverPaneIdsFromStockLayout(
  root: TerminalPaneLayoutNode,
  snapshot: {
    workspace_id: string
    tab_id: string
    panes: { pane_id: string; rect: { x: number; y: number; width: number; height: number } }[]
  }
): Map<string, string> | null {
  const leafIds: string[] = []
  function collectLeaves(node: TerminalPaneLayoutNode): void {
    if (node.type === 'leaf') {
      leafIds.push(node.leafId)
    } else {
      collectLeaves(node.first)
      collectLeaves(node.second)
    }
  }
  collectLeaves(root)

  if (leafIds.length !== snapshot.panes.length) {
    return null
  }

  const direction = root.type === 'split' ? root.direction : 'vertical'
  const isVertical = direction === 'vertical'

  const sortedPanes = [...snapshot.panes].sort((a, b) =>
    isVertical ? a.rect.x - b.rect.x : a.rect.y - b.rect.y
  )

  if (
    (isVertical && sortedPanes.at(0)!.rect.x === sortedPanes.at(-1)!.rect.x) ||
    (!isVertical && sortedPanes.at(0)!.rect.y === sortedPanes.at(-1)!.rect.y)
  ) {
    return null
  }

  const recovered = new Map<string, string>()
  for (let i = 0; i < leafIds.length; i++) {
    recovered.set(leafIds[i], sortedPanes[i].pane_id)
  }

  return recovered
}

export async function restoreOrcaPaneBindings(
  transport: HerdrHostTransport,
  sessionName: string,
  projectId: string,
  root: TerminalPaneLayoutNode,
  _tabId: string,
  snapshot: { panes: { pane_id: string; tokens?: Record<string, string> }[] },
  recovered: Record<string, string> | Map<string, string> | null
): Promise<void> {
  const leafIds: string[] = []
  function collectLeaves(node: TerminalPaneLayoutNode): void {
    if (node.type === 'leaf') {
      leafIds.push(node.leafId)
    } else {
      collectLeaves(node.first)
      collectLeaves(node.second)
    }
  }
  collectLeaves(root)

  const getRecovered = (key: string): string | undefined => {
    if (recovered instanceof Map) {
      return recovered.get(key)
    }
    return recovered?.[key]
  }

  for (const leafId of leafIds) {
    const binding = orcaPaneBinding(projectId, leafId)
    const paneId = getRecovered(leafId)
    if (!paneId) {
      continue
    }

    const pane = snapshot.panes.find((p) => p.pane_id === paneId)
    if (pane && pane.tokens?.[ORCA_BINDING_TOKEN] !== binding) {
      await claimOrcaPaneBinding(transport, sessionName, projectId, leafId, pane, snapshot)
    } else if (!pane) {
      await unwrapHerdrResponse(
        await transport.request(sessionName, 'pane.report_metadata', {
          pane_id: paneId,
          source: ORCA_METADATA_SOURCE,
          tokens: { [ORCA_BINDING_TOKEN]: binding }
        })
      )
    }
    await reclaimExclusiveOrcaPaneBinding(transport, sessionName, snapshot, binding, {
      preferredPaneId: paneId
    })
  }
}

export async function claimOrcaPaneBinding(
  transport: HerdrHostTransport,
  sessionName: string,
  projectId: string,
  leafId: string,
  pane: { pane_id: string; tokens?: Record<string, string> },
  snapshot: { panes: { pane_id: string; tokens?: Record<string, string> }[] }
): Promise<void> {
  const binding = orcaPaneBinding(projectId, leafId)
  if (pane.tokens?.[ORCA_BINDING_TOKEN] === binding) {
    return
  }
  if (
    snapshot.panes.some(
      (c) => c.pane_id !== pane.pane_id && c.tokens?.[ORCA_BINDING_TOKEN] === binding
    )
  ) {
    return
  }
  await unwrapHerdrResponse(
    await transport.request(sessionName, 'pane.report_metadata', {
      pane_id: pane.pane_id,
      source: ORCA_METADATA_SOURCE,
      tokens: { [ORCA_BINDING_TOKEN]: binding }
    })
  )
  pane.tokens = { ...pane.tokens, [ORCA_BINDING_TOKEN]: binding }
}

export async function reportOrcaWorkspaceBinding(
  transport: HerdrHostTransport,
  sessionName: string,
  workspaceId: string,
  binding: string
): Promise<void> {
  await unwrapHerdrResponse(
    await transport.request(sessionName, 'workspace.report_metadata', {
      workspace_id: workspaceId,
      source: ORCA_METADATA_SOURCE,
      tokens: { [ORCA_BINDING_TOKEN]: binding }
    })
  )
}

export function rememberOrcaPaneBindings(
  paneIdsBySessionAndBinding: Map<string, string>,
  sessionName: string,
  _projectId: string,
  snapshot: { panes: { pane_id: string; tokens?: Record<string, string> }[] }
): void {
  for (const pane of snapshot.panes) {
    const token = pane.tokens?.[ORCA_BINDING_TOKEN]
    if (token) {
      paneIdsBySessionAndBinding.set(paneBindingMapKey(sessionName, token), pane.pane_id)
    }
  }
}
