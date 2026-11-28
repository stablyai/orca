import { access } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import type { TrackedBotItems } from './bot-item-dispatch-link-refs'

/** Reads pending item-mail uploads; absence is empty, but an unreadable existing store is unknown. */
export async function retainedItemAttachmentUploads({
  path,
  root,
  tracked,
  current,
  open,
  warn
}: {
  path: string
  root: string
  tracked: () => TrackedBotItems | undefined
  current: () => boolean
  open: () => void
  warn: (error: unknown) => void
}): Promise<ReadonlySet<string> | null> {
  let store = tracked()
  if (!store) {
    const exists = await access(path).then(
      () => true,
      (error) => (isDefinitiveAbsence(error) ? false : null)
    )
    if (exists !== true) {
      return exists === false ? new Set() : null
    }
    if (!current()) {
      return null
    }
    open()
    store = tracked()
    if (!store) {
      return null
    }
  }
  try {
    return new Set(await store.remote.owedCommentAttachmentUploads(root))
  } catch (error) {
    warn(error)
    return null
  }
}
