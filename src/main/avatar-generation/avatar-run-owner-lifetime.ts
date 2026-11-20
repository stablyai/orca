import type { WebContents } from 'electron'

export type AvatarRunOwner = Pick<WebContents, 'once' | 'on' | 'removeListener'>

/** A run belongs to the document that asked: reload or renderer loss would leave the child and its paid job running unseen. */
export function abortWhenOwnerDocumentEnds(
  owner: AvatarRunOwner,
  controller: AbortController
): () => void {
  const abort = (): void => controller.abort()
  const abortOnMainFrameNavigation = (details: {
    isMainFrame: boolean
    isSameDocument: boolean
  }) => {
    if (details.isMainFrame && !details.isSameDocument) {
      abort()
    }
  }
  owner.once('destroyed', abort)
  owner.once('render-process-gone', abort)
  owner.on('did-start-navigation', abortOnMainFrameNavigation)
  return () => {
    owner.removeListener('destroyed', abort)
    owner.removeListener('render-process-gone', abort)
    owner.removeListener('did-start-navigation', abortOnMainFrameNavigation)
  }
}
