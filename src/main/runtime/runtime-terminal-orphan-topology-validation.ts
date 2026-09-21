import type { RuntimeTerminalOrphanAdoptionRequest } from '../../shared/runtime-types'
import { hasExactTerminalOrphanGroupLayout } from './terminal-orphan-topology'

type Claim = RuntimeTerminalOrphanAdoptionRequest['claims'][number]

export function validateRuntimeTerminalOrphanTopology(
  request: RuntimeTerminalOrphanAdoptionRequest,
  validated: readonly { claim: Claim }[]
) {
  const topologyTabsById = new Map(request.topology?.tabs.map((tab) => [tab.tabId, tab]) ?? [])
  const topologyGroups = request.topology?.groups ?? []
  if (!request.topology) {
    return { topologyTabsById, topologyGroups }
  }
  const claimedLeafIdsByTabId = new Map<string, Set<string>>()
  for (const { claim } of validated) {
    const leafIds = claimedLeafIdsByTabId.get(claim.tabId) ?? new Set<string>()
    leafIds.add(claim.leafId)
    claimedLeafIdsByTabId.set(claim.tabId, leafIds)
  }
  if (
    topologyTabsById.size !== request.topology.tabs.length ||
    topologyTabsById.size !== claimedLeafIdsByTabId.size
  ) {
    throw new Error('terminal_orphan_topology_invalid')
  }
  for (const [tabId, claimedLeafIds] of claimedLeafIdsByTabId) {
    const topologyTab = topologyTabsById.get(tabId)
    if (!topologyTab) {
      throw new Error('terminal_orphan_topology_invalid')
    }
    const topologyLeafIds = new Set<string>()
    const nodes = [topologyTab.root]
    let leafCount = 0
    while (nodes.length > 0) {
      const node = nodes.pop()!
      if (node.type === 'leaf') {
        leafCount += 1
        topologyLeafIds.add(node.leafId)
      } else {
        nodes.push(node.first, node.second)
      }
    }
    if (
      leafCount !== topologyLeafIds.size ||
      topologyLeafIds.size !== claimedLeafIds.size ||
      [...topologyLeafIds].some((leafId) => !claimedLeafIds.has(leafId)) ||
      !topologyLeafIds.has(topologyTab.activeLeafId) ||
      (topologyTab.expandedLeafId !== null && !topologyLeafIds.has(topologyTab.expandedLeafId))
    ) {
      throw new Error('terminal_orphan_topology_invalid')
    }
  }
  const seenGroupIds = new Set<string>()
  const groupedTabIds = new Set<string>()
  for (const group of topologyGroups) {
    if (seenGroupIds.has(group.id) || !group.tabOrder.includes(group.activeTabId)) {
      throw new Error('terminal_orphan_topology_invalid')
    }
    seenGroupIds.add(group.id)
    for (const tabId of group.tabOrder) {
      if (!topologyTabsById.has(tabId) || groupedTabIds.has(tabId)) {
        throw new Error('terminal_orphan_topology_invalid')
      }
      groupedTabIds.add(tabId)
    }
    if (group.recentTabIds?.some((tabId) => !group.tabOrder.includes(tabId))) {
      throw new Error('terminal_orphan_topology_invalid')
    }
  }
  if (groupedTabIds.size !== topologyTabsById.size) {
    throw new Error('terminal_orphan_topology_invalid')
  }
  if (
    request.topology.groupLayout &&
    !hasExactTerminalOrphanGroupLayout(request.topology.groupLayout, seenGroupIds)
  ) {
    throw new Error('terminal_orphan_topology_invalid')
  }
  return { topologyTabsById, topologyGroups }
}
