import type { WebContents } from 'electron'

export type AvatarRunOwner = Pick<WebContents, 'once' | 'removeListener' | 'isDestroyed'>

/** A run belongs to the document that asked: reload or renderer loss would leave the child and its paid job running unseen. A committed main-frame navigation (not a blocked one) is what ends the document. */
export function abortWhenOwnerDocumentEnds(
  owner: AvatarRunOwner,
  controller: AbortController
): () => void {
  const abort = (): void => controller.abort()
  if (owner.isDestroyed()) {
    abort()
  }
  owner.once('destroyed', abort)
  owner.once('render-process-gone', abort)
  owner.once('did-navigate', abort)
  return () => {
    owner.removeListener('destroyed', abort)
    owner.removeListener('render-process-gone', abort)
    owner.removeListener('did-navigate', abort)
  }
}
