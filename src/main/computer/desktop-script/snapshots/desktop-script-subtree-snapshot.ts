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
  const baseByRuntimeId = new Map<string, BridgeElement | Map<string, BridgeElement[]>>()
  let nextIndex = base.nextElementIndex ?? 0
  let requestedRoot: BridgeElement | undefined
  // Build backwards so duplicate candidates pop in their original order.
  for (let position = baseElements.length - 1; position >= 0; position--) {
    const element = baseElements[position]
    nextIndex = Math.max(nextIndex, element.index + 1)
    if (element.index === rootElementIndex) {
      requestedRoot = element
    }
    const key = runtimeIdKey(element)
    if (key === null) {
      continue
    }
    const known = baseByRuntimeId.get(key)
    if (!known) {
      baseByRuntimeId.set(key, element)
      continue
    }
    const signatures =
      known instanceof Map ? known : new Map([[elementSignatureKey(known), [known]]])
    const signature = elementSignatureKey(element)
    const candidates = signatures.get(signature)
    if (candidates) {
      candidates.push(element)
    } else {
      signatures.set(signature, [element])
    }
    if (signatures !== known) {
      baseByRuntimeId.set(key, signatures)
    }
  }
  const requestedRootKey = requestedRoot ? runtimeIdKey(requestedRoot) : null
  const indexes: number[] = []
  const claimed = new Set<number>()
  const subtreeElements = subtree.elements ?? []
  const walked: BridgeElement[] = []
  walked.length = subtreeElements.length
  const subtreeReadRoots = new Map<number, number>()
  for (let position = 0; position < subtreeElements.length; position++) {
    const element = subtreeElements[position]
    const key = runtimeIdKey(element)
    // Why: the provider resolved the rendered root from the requested handle, so it is that element
    // even if its name changed; Windows resolves index 0 only as the window, never by runtime id.
    const isRequestedRoot = position === 0 && key !== null && key === requestedRootKey
    let known = isRequestedRoot ? requestedRoot : undefined
    if (!isRequestedRoot) {
      const candidate = key === null ? undefined : baseByRuntimeId.get(key)
      if (candidate instanceof Map) {
        const candidates = candidate.get(elementSignatureKey(element))
        known = candidates?.pop()
        while (known && claimed.has(known.index)) {
          known = candidates?.pop()
        }
      } else if (
        candidate &&
        !claimed.has(candidate.index) &&
        sameElementSignature(candidate, element)
      ) {
        known = candidate
      }
    }
    const index = known?.index ?? nextIndex++
    claimed.add(index)
    indexes[element.index] = index
    walked[position] = { ...element, index }
    if (index !== rootElementIndex) {
      subtreeReadRoots.set(index, rootElementIndex)
    }
  }
  const focusedElementId =
    subtree.focusedElementId === null || subtree.focusedElementId === undefined
      ? subtree.focusedElementId
      : (indexes[subtree.focusedElementId] ?? null)
  const indexLookup = { get: (index: number) => indexes[index] }
  const shown: BridgeSnapshot = {
    ...subtree,
    treeLines: subtree.treeLines?.map((line) => renumberComputerTreeLine(line, indexLookup)),
    focusedElementId,
    elements: walked,
    rootElementIndex
  }
  const baseReadRoots = base.subtreeReadRoots
  const elidedRoot = requestedRoot && !claimed.has(rootElementIndex) ? requestedRoot : undefined
  const retentionBudget = Math.max(
    0,
    MAX_CACHED_SUBTREE_SNAPSHOT_ELEMENTS - walked.length - (elidedRoot ? 1 : 0)
  )
  const retained: BridgeElement[] = []
  // Start at the newest cached elements and stop once the remaining budget is full.
  for (
    let position = baseElements.length - 1;
    position >= 0 && retained.length < retentionBudget;
    position--
  ) {
    const element = baseElements[position]
    const readRoot = baseReadRoots?.get(element.index)
    if (
      element.index !== rootElementIndex &&
      !claimed.has(element.index) &&
      readRoot !== rootElementIndex
    ) {
      retained.push(element)
      if (readRoot !== undefined) {
        subtreeReadRoots.set(element.index, readRoot)
      }
    }
  }
  retained.reverse()
  const elements = retained.concat(walked)
  if (elidedRoot) {
    elements.push(elidedRoot)
  }
  const requestedReadRoot = baseReadRoots?.get(rootElementIndex)
  if (requestedReadRoot !== undefined) {
    subtreeReadRoots.set(rootElementIndex, requestedReadRoot)
  }
  const cached: BridgeSnapshot = {
    ...shown,
    elements,
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

// Mirrors the Linux resolver's same_element_signature check.
function sameElementSignature(left: BridgeElement, right: BridgeElement): boolean {
  const leftActions = left.actions ?? []
  const rightActions = right.actions ?? []
  return (
    (left.controlType ?? '') === (right.controlType ?? '') &&
    (left.name ?? '') === (right.name ?? '') &&
    (left.automationId ?? '') === (right.automationId ?? '') &&
    leftActions.length === rightActions.length &&
    leftActions.every((action, position) => action === rightActions[position])
  )
}

function elementSignatureKey(element: BridgeElement): string {
  return JSON.stringify([
    element.controlType ?? '',
    element.name ?? '',
    element.automationId ?? '',
    element.actions ?? []
  ])
}
