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

// Two maximal provider walks: both providers stop at 1200 elements.
const MAX_CACHED_SUBTREE_SNAPSHOT_ELEMENTS = 2400

/**
 * Gives a subtree read the indexes the window's cached snapshot already uses: elements it showed
 * keep theirs, new ones get never-used indexes. Returns what to show and what to cache, where the
 * cache keeps earlier elements so their indexes still resolve for actions, except those an earlier
 * read of this root returned and this one did not, and the least recently returned beyond the cap.
 */
function indexSubtreeSnapshot(
  base: BridgeSnapshot,
  subtree: BridgeSnapshot,
  rootElementIndex: number
): { shown: BridgeSnapshot; cached: BridgeSnapshot } {
  const baseElements = base.elements ?? []
  const baseByIdentity = new Map<string, BridgeElement[]>()
  let nextIndex = base.nextElementIndex ?? 0
  for (const element of baseElements) {
    nextIndex = Math.max(nextIndex, element.index + 1)
    const key = elementIdentityKey(element)
    const candidates = key === null ? undefined : baseByIdentity.get(key)
    if (candidates) {
      candidates.push(element)
    } else if (key !== null) {
      baseByIdentity.set(key, [element])
    }
  }
  // Pop the earliest matching candidate without rescanning duplicate runtime ids.
  for (const candidates of baseByIdentity.values()) {
    candidates.reverse()
  }
  const requestedRoot = baseElements.find((element) => element.index === rootElementIndex)
  const requestedRootKey = requestedRoot ? runtimeIdKey(requestedRoot) : null
  const indexes = new Map<number, number>()
  const claimed = new Set<number>()
  for (const [position, element] of (subtree.elements ?? []).entries()) {
    const key = runtimeIdKey(element)
    // Why: the provider resolved the rendered root from the requested handle, so it is that element
    // even if its name changed; Windows resolves index 0 only as the window, never by runtime id.
    const isRequestedRoot = position === 0 && key !== null && key === requestedRootKey
    const identityKey = isRequestedRoot ? null : elementIdentityKey(element)
    const candidates = identityKey === null ? undefined : baseByIdentity.get(identityKey)
    let known = isRequestedRoot ? requestedRoot : candidates?.pop()
    while (known && claimed.has(known.index)) {
      known = candidates?.pop()
    }
    const index = known?.index ?? nextIndex++
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
  const baseReadRoots = base.subtreeReadRoots ?? new Map<number, number>()
  const kept = baseElements.filter(
    (element) =>
      !claimed.has(element.index) && baseReadRoots.get(element.index) !== rootElementIndex
  )
  // The cache is ordered by when a read last returned each element, so the oldest go first.
  const retained = kept.slice(
    Math.max(0, kept.length + walked.length - MAX_CACHED_SUBTREE_SNAPSHOT_ELEMENTS)
  )
  const subtreeReadRoots = new Map<number, number>()
  for (const element of [...retained, ...walked]) {
    const readRoot =
      claimed.has(element.index) && element.index !== rootElementIndex
        ? rootElementIndex
        : baseReadRoots.get(element.index)
    if (readRoot !== undefined) {
      subtreeReadRoots.set(element.index, readRoot)
    }
  }
  const cached: BridgeSnapshot = {
    ...shown,
    elements: [...retained, ...walked],
    subtreeReadRoots,
    nextElementIndex: nextIndex
  }
  return { shown, cached }
}

function runtimeIdKey(element: BridgeElement): string | null {
  return Array.isArray(element.runtimeId) && element.runtimeId.length > 0
    ? JSON.stringify(element.runtimeId)
    : null
}

// Linux runtime ids are tree positions; require the resolver's signature as well.
function elementIdentityKey(element: BridgeElement): string | null {
  return !Array.isArray(element.runtimeId) || element.runtimeId.length === 0
    ? null
    : JSON.stringify([
        element.runtimeId,
        element.controlType ?? '',
        element.name ?? '',
        element.automationId ?? '',
        element.actions ?? []
      ])
}
