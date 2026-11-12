import type { ComputerSnapshotResult } from '../../../../shared/computer-use-runtime-types'
import { renumberComputerTreeLine } from '../../../../shared/computer-use-tree-text'
import { RuntimeClientError } from '../../runtime-client-error'
import { elementParam } from '../actions/desktop-script-action'
import { optionalNumberParam } from '../desktop-script-provider-params'
import type {
  BridgeElement,
  BridgeRequest,
  BridgeResponse,
  BridgeSnapshot
} from '../desktop-script-provider-types'
import type { DesktopScriptSnapshotStore } from './desktop-script-snapshot-store'
import { renderSnapshot } from './desktop-script-snapshot-rendering'

/** Reads one element's subtree of the window the store last saw, the target of --element-index. */
export async function readSubtreeSnapshot(
  store: DesktopScriptSnapshotStore,
  callBridge: (request: BridgeRequest) => Promise<BridgeResponse>,
  {
    app,
    rootElementIndex,
    params
  }: { app: string; rootElementIndex: number; params: Record<string, unknown> }
): Promise<ComputerSnapshotResult> {
  const base = store.current(app, optionalNumberParam(params, 'windowId'), params)
  if (!base) {
    throw new RuntimeClientError(
      'element_not_found',
      '--element-index needs a get-app-state snapshot of this app/window first'
    )
  }
  const response = await callBridge({
    tool: 'get_app_state',
    app,
    root: elementParam(base, rootElementIndex),
    windowId: base.windowId ?? undefined,
    windowIndex: base.windowIndex ?? undefined,
    noScreenshot: params.noScreenshot === true,
    restoreWindow: params.restoreWindow === true
  })
  if (!response.snapshot) {
    throw new RuntimeClientError('accessibility_error', 'desktop provider returned no snapshot')
  }
  const { shown, cached } = indexSubtreeSnapshot(base, response.snapshot, rootElementIndex)
  store.remember(app, cached, params)
  return renderSnapshot(shown, params.noScreenshot === true)
}

/**
 * Gives a subtree read the indexes the window's cached snapshot already uses: elements it showed
 * keep theirs, new ones get unused indexes. Returns what to show and what to cache, where the
 * cache keeps the earlier elements so their indexes still resolve for actions.
 */
function indexSubtreeSnapshot(
  base: BridgeSnapshot,
  subtree: BridgeSnapshot,
  rootElementIndex: number
): { shown: BridgeSnapshot; cached: BridgeSnapshot } {
  const baseElements = base.elements ?? []
  const baseIndexByRuntimeId = new Map<string, number>()
  for (const element of baseElements) {
    const key = runtimeIdKey(element)
    if (key !== null && !baseIndexByRuntimeId.has(key)) {
      baseIndexByRuntimeId.set(key, element.index)
    }
  }
  let nextIndex = baseElements.reduce((max, element) => Math.max(max, element.index), -1) + 1
  const indexes = new Map<number, number>()
  const claimed = new Set<number>()
  for (const element of subtree.elements ?? []) {
    const key = runtimeIdKey(element)
    const known = key === null ? undefined : baseIndexByRuntimeId.get(key)
    const index = known !== undefined && !claimed.has(known) ? known : nextIndex++
    claimed.add(index)
    indexes.set(element.index, index)
  }
  const walked = (subtree.elements ?? []).map((element) => ({
    ...element,
    index: indexes.get(element.index) ?? element.index
  }))
  const focusedElementId =
    subtree.focusedElementId === null || subtree.focusedElementId === undefined
      ? subtree.focusedElementId
      : (indexes.get(subtree.focusedElementId) ?? null)
  const shown: BridgeSnapshot = {
    ...subtree,
    treeLines: subtree.treeLines?.map((line) => renumberComputerTreeLine(line, indexes)),
    focusedElementId,
    elements: walked,
    rootElementIndex
  }
  const cached: BridgeSnapshot = {
    ...shown,
    elements: [...baseElements.filter((element) => !claimed.has(element.index)), ...walked]
  }
  return { shown, cached }
}

function runtimeIdKey(element: BridgeElement): string | null {
  return Array.isArray(element.runtimeId) && element.runtimeId.length > 0
    ? JSON.stringify(element.runtimeId)
    : null
}
