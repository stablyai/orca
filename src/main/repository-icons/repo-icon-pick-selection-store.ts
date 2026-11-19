import { randomBytes } from 'node:crypto'
import type { WebContents } from 'electron'
import type { RepoIconPickPendingResult } from '../../shared/repository/appearance/repo-icon-pick-result'

type StoredRepoIconSelection = {
  token: string
  filePath: string
  fileName: string
  originalBytes: number
  originalMimeType: 'image/png' | 'image/jpeg'
}

// One pending selection per sender: a newer pick replaces the old token immediately.
const selections = new WeakMap<WebContents, StoredRepoIconSelection>()

export function rememberRepoIconSelection(
  sender: WebContents,
  selection: Omit<StoredRepoIconSelection, 'token'>
): RepoIconPickPendingResult {
  const token = randomBytes(32).toString('base64url')
  selections.set(sender, { ...selection, token })
  return {
    kind: 'pending',
    token,
    fileName: selection.fileName,
    originalBytes: selection.originalBytes,
    originalMimeType: selection.originalMimeType
  }
}

/** Returns the path only for the sender's most recent token, so stale previews cannot read files. */
export function resolveRepoIconSelection(
  sender: WebContents,
  token: string
): StoredRepoIconSelection | null {
  const selection = selections.get(sender)
  return selection?.token === token ? selection : null
}
