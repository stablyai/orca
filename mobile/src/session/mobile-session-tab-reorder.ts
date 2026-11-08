import type { ActionSheetAction } from '../components/ActionSheetModal'
import { translate } from '../i18n/mobile-i18n'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileSessionTab, MobileSessionTabGroup } from './mobile-session-route-types'
import { sessionTabMove } from './mobile-session-write-operations'

type MoveClient = Parameters<typeof sessionTabMove.request>[0]

export type TopLevelSessionTabBlock = {
  topLevelTabId: string
  tabs: MobileSessionTab[]
}

export type SessionTabReorderRpcMove =
  | {
      tabId: string
      targetGroupId: string
      kind: 'reorder'
      tabOrder: string[]
    }
  | {
      tabId: string
      targetGroupId: string
      kind: 'move-to-group'
      index: number
    }

export type SessionTabReorderMoveParams = SessionTabReorderRpcMove & {
  worktree: string
}

export type SessionTabReorderPlan = {
  topLevelTabId: string
  fromBlockIndex: number
  toBlockIndex: number
  reorderedTabs: MobileSessionTab[]
  reorderedTabGroups: MobileSessionTabGroup[]
  rpcMove: SessionTabReorderRpcMove
}

export function getTopLevelSessionTabId(
  tab: Pick<MobileSessionTab, 'id' | 'type'> & { parentTabId?: string }
): string {
  if (
    tab.type === 'terminal' &&
    typeof tab.parentTabId === 'string' &&
    tab.parentTabId.length > 0
  ) {
    return tab.parentTabId
  }
  return tab.id
}

export function groupSessionTabsByTopLevelId(
  tabs: readonly MobileSessionTab[]
): TopLevelSessionTabBlock[] {
  const blocks: TopLevelSessionTabBlock[] = []
  const byId = new Map<string, TopLevelSessionTabBlock>()
  for (const tab of tabs) {
    const topLevelTabId = getTopLevelSessionTabId(tab)
    const existing = byId.get(topLevelTabId)
    if (existing) {
      existing.tabs.push(tab)
      continue
    }
    const created: TopLevelSessionTabBlock = { topLevelTabId, tabs: [tab] }
    byId.set(topLevelTabId, created)
    blocks.push(created)
  }
  return blocks
}

export function canMoveSessionTabByOffset(
  tabs: readonly MobileSessionTab[],
  tabId: string,
  delta: -1 | 1
): boolean {
  const blocks = groupSessionTabsByTopLevelId(tabs)
  const sourceIndex = blocks.findIndex(
    (block) => block.topLevelTabId === tabId || block.tabs.some((tab) => tab.id === tabId)
  )
  const destinationIndex = sourceIndex + delta
  return (
    blocks.length >= 2 &&
    sourceIndex !== -1 &&
    destinationIndex >= 0 &&
    destinationIndex < blocks.length
  )
}

export function computeSessionTabReorderPlan(args: {
  tabs: readonly MobileSessionTab[]
  tabGroups?: readonly MobileSessionTabGroup[]
  activeGroupId?: string | null
  tabId: string
  targetBlockIndex?: number
  delta?: -1 | 1
}): SessionTabReorderPlan | null {
  const blocks = groupSessionTabsByTopLevelId(args.tabs)
  const fromBlockIndex = blocks.findIndex(
    (block) => block.topLevelTabId === args.tabId || block.tabs.some((tab) => tab.id === args.tabId)
  )
  if (blocks.length < 2 || fromBlockIndex === -1) {
    return null
  }
  const rawDestination =
    typeof args.targetBlockIndex === 'number'
      ? Math.max(0, Math.min(blocks.length - 1, Math.floor(args.targetBlockIndex)))
      : typeof args.delta === 'number'
        ? fromBlockIndex + args.delta
        : fromBlockIndex
  if (rawDestination < 0 || rawDestination >= blocks.length || rawDestination === fromBlockIndex) {
    return null
  }

  const movingBlock = blocks[fromBlockIndex]!
  const destinationBlock = blocks[rawDestination]!
  const nextBlocks = [...blocks]
  nextBlocks.splice(fromBlockIndex, 1)
  nextBlocks.splice(rawDestination, 0, movingBlock)
  const reorderedTabs = nextBlocks.flatMap((block) => block.tabs)
  const topLevelTabId = movingBlock.topLevelTabId

  const currentGroups = args.tabGroups
    ? args.tabGroups.map((g) => ({ ...g, tabOrder: [...g.tabOrder] }))
    : []
  const sourceGroup = currentGroups.find((g) => g.tabOrder.includes(topLevelTabId))
  const destinationGroup =
    currentGroups.find((g) => g.tabOrder.includes(destinationBlock.topLevelTabId)) ?? sourceGroup

  if (sourceGroup && destinationGroup && sourceGroup.id === destinationGroup.id) {
    const fromIdxInGroup = sourceGroup.tabOrder.indexOf(topLevelTabId)
    const toIdxInGroup = sourceGroup.tabOrder.indexOf(destinationBlock.topLevelTabId)
    if (fromIdxInGroup !== -1 && toIdxInGroup !== -1 && fromIdxInGroup !== toIdxInGroup) {
      const nextOrder = [...sourceGroup.tabOrder]
      nextOrder.splice(fromIdxInGroup, 1)
      nextOrder.splice(toIdxInGroup, 0, topLevelTabId)
      sourceGroup.tabOrder = nextOrder
      return {
        topLevelTabId,
        fromBlockIndex,
        toBlockIndex: rawDestination,
        reorderedTabs,
        reorderedTabGroups: currentGroups,
        rpcMove: {
          tabId: topLevelTabId,
          targetGroupId: sourceGroup.id,
          kind: 'reorder',
          tabOrder: nextOrder
        }
      }
    }
  }

  if (sourceGroup && destinationGroup && sourceGroup.id !== destinationGroup.id) {
    sourceGroup.tabOrder = sourceGroup.tabOrder.filter((id) => id !== topLevelTabId)
    const destIdx = destinationGroup.tabOrder.indexOf(destinationBlock.topLevelTabId)
    const insertIdx =
      destIdx === -1
        ? destinationGroup.tabOrder.length
        : rawDestination > fromBlockIndex
          ? destIdx + 1
          : destIdx
    const nextDestOrder = [...destinationGroup.tabOrder]
    nextDestOrder.splice(insertIdx, 0, topLevelTabId)
    destinationGroup.tabOrder = nextDestOrder
    return {
      topLevelTabId,
      fromBlockIndex,
      toBlockIndex: rawDestination,
      reorderedTabs,
      reorderedTabGroups: currentGroups,
      rpcMove: {
        tabId: topLevelTabId,
        targetGroupId: destinationGroup.id,
        kind: 'move-to-group',
        index: insertIdx
      }
    }
  }

  const fallbackGroupId = args.activeGroupId ?? currentGroups[0]?.id ?? 'default'
  const fallbackTabOrder = nextBlocks.map((block) => block.topLevelTabId)
  return {
    topLevelTabId,
    fromBlockIndex,
    toBlockIndex: rawDestination,
    reorderedTabs,
    reorderedTabGroups:
      currentGroups.length > 0
        ? currentGroups
        : [{ id: fallbackGroupId, activeTabId: topLevelTabId, tabOrder: fallbackTabOrder }],
    rpcMove: {
      tabId: topLevelTabId,
      targetGroupId: fallbackGroupId,
      kind: 'reorder',
      tabOrder: fallbackTabOrder
    }
  }
}

export function resolveDraggedTabTargetIndex(args: {
  draggedTabId: string
  dragDx: number
  tabs: readonly MobileSessionTab[]
  layouts: ReadonlyMap<string, { x: number; width: number }>
}): number | null {
  const blocks = groupSessionTabsByTopLevelId(args.tabs)
  if (blocks.length < 2) {
    return null
  }
  const sourceBlockIndex = blocks.findIndex(
    (block) =>
      block.topLevelTabId === args.draggedTabId ||
      block.tabs.some((tab) => tab.id === args.draggedTabId)
  )
  if (sourceBlockIndex === -1) {
    return null
  }
  const blockBounds = blocks.map((block) => {
    let minX = Number.POSITIVE_INFINITY
    let maxRight = Number.NEGATIVE_INFINITY
    for (const tab of block.tabs) {
      const layout = args.layouts.get(tab.id)
      if (!layout) {
        continue
      }
      minX = Math.min(minX, layout.x)
      maxRight = Math.max(maxRight, layout.x + layout.width)
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxRight)) {
      return null
    }
    return { x: minX, width: Math.max(1, maxRight - minX) }
  })
  const origin = blockBounds[sourceBlockIndex]
  if (!origin) {
    return null
  }
  const draggedCenter = origin.x + origin.width / 2 + args.dragDx
  let targetIndex = sourceBlockIndex
  if (args.dragDx > 0) {
    for (let index = sourceBlockIndex + 1; index < blockBounds.length; index++) {
      const candidate = blockBounds[index]
      if (!candidate) {
        continue
      }
      if (draggedCenter >= candidate.x + candidate.width / 2) {
        targetIndex = index
      }
    }
  } else if (args.dragDx < 0) {
    for (let index = sourceBlockIndex - 1; index >= 0; index--) {
      const candidate = blockBounds[index]
      if (!candidate) {
        continue
      }
      if (draggedCenter <= candidate.x + candidate.width / 2) {
        targetIndex = index
      }
    }
  }
  return targetIndex === sourceBlockIndex ? null : targetIndex
}

export async function requestMobileSessionTabMove(
  client: MoveClient,
  params: SessionTabReorderMoveParams
): Promise<RpcResponse> {
  try {
    return await sessionTabMove.request(client, params)
  } catch (error) {
    if (!(error instanceof LogicalClientCutoverError)) {
      throw error
    }
    return sessionTabMove.request(client, params)
  }
}

export function createReorderTabSheetActions(args: {
  tabs: readonly MobileSessionTab[]
  anchorTabId: string | null | undefined
  onMoveByOffset?: (tabId: string, delta: -1 | 1) => void
  onDismiss?: () => void
}): ActionSheetAction[] {
  const { anchorTabId, onMoveByOffset } = args
  if (!anchorTabId || !onMoveByOffset) {
    return []
  }
  const canMoveLeft = canMoveSessionTabByOffset(args.tabs, anchorTabId, -1)
  const canMoveRight = canMoveSessionTabByOffset(args.tabs, anchorTabId, 1)
  const actions: ActionSheetAction[] = []
  if (canMoveLeft) {
    actions.push({
      id: 'moveTabLeft',
      label: translate('session.tabReorder.moveLeft', 'Move Tab Left'),
      onPress: () => {
        args.onDismiss?.()
        onMoveByOffset(anchorTabId, -1)
      }
    })
  }
  if (canMoveRight) {
    actions.push({
      id: 'moveTabRight',
      label: translate('session.tabReorder.moveRight', 'Move Tab Right'),
      onPress: () => {
        args.onDismiss?.()
        onMoveByOffset(anchorTabId, 1)
      }
    })
  }
  return actions
}
