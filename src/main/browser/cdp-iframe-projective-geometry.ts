import type { WebContents } from 'electron'
import { BrowserError } from './browser-error'
import type { CdpTabState } from './cdp-auxiliary-commands'
import type { CdpCommandSender } from './snapshot-engine'

export type CdpBoxModel = {
  content?: number[]
  padding?: number[]
  border?: number[]
}

export type IframeOwnerGeometry = {
  backendNodeId: number
  contentQuad: number[]
  parentSessionId: string | null
  viewportHeight: number
  viewportWidth: number
}

export type CdpIframeGeometryHost = {
  resolveTabId(webContentsId: number): string
  getOrCreateTabState(tabId: string): CdpTabState
  makeCdpSender(guest: WebContents, sessionId?: string): CdpCommandSender
}

export function isMissingLayoutBoxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /could not compute box model|node does not have a layout object/i.test(message)
}

export function isUsableBoxQuad(quad: number[] | undefined): quad is number[] {
  if (!quad || quad.length < 8 || !quad.slice(0, 8).every(Number.isFinite)) {
    return false
  }
  let twiceArea = 0
  for (let index = 0; index < 4; index++) {
    const next = (index + 1) % 4
    twiceArea += quad[index * 2] * quad[next * 2 + 1] - quad[next * 2] * quad[index * 2 + 1]
  }
  return Math.abs(twiceArea) > 1e-6
}

// Why: projective unit-square mapping keeps perspective iframe coordinates aligned.
export function mapViewportPointToQuad(
  quad: number[],
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number
): { cx: number; cy: number } | null {
  const horizontalRatio = x / viewportWidth
  const verticalRatio = y / viewportHeight
  const [x0, y0, x1, y1, x2, y2, x3, y3] = quad
  const deltaX1 = x1 - x2
  const deltaX2 = x3 - x2
  const deltaX3 = x0 - x1 + x2 - x3
  const deltaY1 = y1 - y2
  const deltaY2 = y3 - y2
  const deltaY3 = y0 - y1 + y2 - y3
  const determinant = deltaX1 * deltaY2 - deltaX2 * deltaY1
  if (Math.abs(determinant) <= 1e-9) {
    return null
  }
  const projectiveX = (deltaX3 * deltaY2 - deltaX2 * deltaY3) / determinant
  const projectiveY = (deltaX1 * deltaY3 - deltaX3 * deltaY1) / determinant
  const denominator = projectiveX * horizontalRatio + projectiveY * verticalRatio + 1
  if (Math.abs(denominator) <= 1e-9) {
    return null
  }
  const cx =
    ((x1 - x0 + projectiveX * x1) * horizontalRatio +
      (x3 - x0 + projectiveY * x3) * verticalRatio +
      x0) /
    denominator
  const cy =
    ((y1 - y0 + projectiveX * y1) * horizontalRatio +
      (y3 - y0 + projectiveY * y3) * verticalRatio +
      y0) /
    denominator
  return Number.isFinite(cx) && Number.isFinite(cy) ? { cx, cy } : null
}

export async function readElementBoxModel(
  sender: CdpCommandSender,
  backendNodeId: number,
  missingLayoutMessage: string
): Promise<CdpBoxModel> {
  try {
    const { model } = (await sender('DOM.getBoxModel', { backendNodeId })) as {
      model: CdpBoxModel
    }
    return model
  } catch (error) {
    if (error instanceof BrowserError || !isMissingLayoutBoxError(error)) {
      throw error
    }
    throw new BrowserError('browser_element_not_interactable', missingLayoutMessage)
  }
}

export async function resolveIframeOwnerGeometry(
  host: CdpIframeGeometryHost,
  guest: WebContents,
  sessionId: string
): Promise<IframeOwnerGeometry> {
  const tabId = host.resolveTabId(guest.id)
  const state = host.getOrCreateTabState(tabId)
  if (
    ![...state.iframeSessions.values()].includes(sessionId) ||
    !state.iframeParentSessions.has(sessionId)
  ) {
    throw new BrowserError(
      'browser_stale_ref',
      "The element's iframe is no longer attached. Run 'orca snapshot' to get fresh refs."
    )
  }
  const parentSessionId = state.iframeParentSessions.get(sessionId) ?? null
  const parentSender = host.makeCdpSender(guest, parentSessionId ?? undefined)
  const childSender = host.makeCdpSender(guest, sessionId)
  const [{ frameTree }, { cssLayoutViewport }] = (await Promise.all([
    childSender('Page.getFrameTree'),
    childSender('Page.getLayoutMetrics')
  ])) as [
    { frameTree?: { frame?: { id?: string } } },
    { cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }
  ]
  const frameId = frameTree?.frame?.id
  if (!frameId) {
    throw new BrowserError(
      'browser_element_not_interactable',
      'Could not resolve the iframe coordinate space. Re-snapshot and retry.'
    )
  }
  const { backendNodeId } = (await parentSender('DOM.getFrameOwner', { frameId })) as {
    backendNodeId?: number
  }
  if (!backendNodeId) {
    throw new BrowserError(
      'browser_element_not_interactable',
      'Could not resolve the iframe owner. Re-snapshot and retry.'
    )
  }
  const model = await readElementBoxModel(
    parentSender,
    backendNodeId,
    'The iframe has no layout box. Re-snapshot and retry.'
  )
  const content = model?.content
  const viewportWidth = cssLayoutViewport?.clientWidth
  const viewportHeight = cssLayoutViewport?.clientHeight
  if (
    !isUsableBoxQuad(content) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    !viewportWidth ||
    !viewportHeight ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    throw new BrowserError(
      'browser_element_not_interactable',
      'The iframe has no usable layout box. Re-snapshot and retry.'
    )
  }
  return {
    backendNodeId,
    contentQuad: content,
    parentSessionId,
    viewportHeight,
    viewportWidth
  }
}
