import type {
  BrowserClientPageRendererReply as RendererReply,
  BrowserClientPageRendererRequest as RendererRequest
} from '../../shared/browser-client-page-renderer-protocol'

export type BrowserClientPageRendererFrame = object

export type BrowserClientPageRendererEndpoint = {
  id: number
  mainFrame: BrowserClientPageRendererFrame
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

export type BrowserClientPageRendererReplyEvent = {
  sender: BrowserClientPageRendererEndpoint
  senderFrame: BrowserClientPageRendererFrame | null
}

export function readCurrentRendererFrame(
  endpoint: BrowserClientPageRendererEndpoint
): BrowserClientPageRendererFrame | null {
  try {
    if (endpoint.isDestroyed()) {
      return null
    }
    const frame = endpoint.mainFrame
    return frame && typeof frame === 'object' ? frame : null
  } catch {
    return null
  }
}

export function readRendererReplyRequestId(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object' || !('requestId' in candidate)) {
    return null
  }
  const requestId = candidate.requestId
  return typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 256
    ? requestId
    : null
}

export function rendererReplyMatchesRequest(
  reply: RendererReply,
  request: RendererRequest
): boolean {
  const expectedType =
    request.type === 'mountPage' ? 'mounted' : request.type === 'retirePage' ? 'retired' : 'rekeyed'
  return Boolean(
    (reply.type === expectedType ||
      (reply.type === 'failed' && reply.operation === request.type)) &&
    reply.page.partition === request.page.partition &&
    reply.page.browserPageId === request.page.browserPageId &&
    reply.page.pageHostGeneration === request.page.pageHostGeneration &&
    (request.type !== 'rekeyPage' ||
      reply.type === 'failed' ||
      (reply.type === 'rekeyed' &&
        reply.nextPage.partition === request.nextPage.partition &&
        reply.nextPage.browserPageId === request.nextPage.browserPageId &&
        reply.nextPage.pageHostGeneration === request.nextPage.pageHostGeneration))
  )
}
