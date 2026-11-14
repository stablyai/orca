import {
  remoteRpcContentBudget,
  remoteRpcResultExceedsContentBudget
} from '../../../../../shared/remote-rpc-content-budget'
import type { DirEntry } from '../../../../../shared/file-listing/directory-entry'
import { dirListingTooLargeForRemoteMessage } from '../../../../../shared/file-listing/file-dir-page'

export function remoteFileContentBudget(
  clientKind: 'mobile' | 'runtime' | undefined,
  requestId: string | undefined
): number | undefined {
  return clientKind && requestId ? remoteRpcContentBudget(requestId) : undefined
}

/** `maxBytes === undefined` means uncapped: local and in-process callers keep the full listing. */
export function assertDirListingWithinRemoteBudget(
  entries: DirEntry[],
  maxBytes: number | undefined
): DirEntry[] {
  if (maxBytes === undefined || !remoteRpcResultExceedsContentBudget(entries, maxBytes)) {
    return entries
  }
  throw new Error(dirListingTooLargeForRemoteMessage(entries.length))
}
