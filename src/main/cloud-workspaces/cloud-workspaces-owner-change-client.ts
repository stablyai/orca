// OWNER-TRANSFER: changing a workspace's owner and the previous owner's notices, on the same
// authenticated call as the rest of the team registry client.
import type { z } from 'zod'
import {
  OwnerChangeNoticeDismissedSchema,
  OwnerChangeNoticeListSchema,
  OwnerChangeResponseSchema,
  type OwnerChange,
  type OwnerChangeNotice
} from '../../shared/cloud-workspaces/owner-change-wire'

type Call = <T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  timeoutMs?: number
) => Promise<T>

/**
 * The control plane puts the workspace to sleep before it changes the owner, then asks Orca Cloud
 * auth up to three things (6 s each). The usual 20 s would give up on a change that then lands.
 */
export const OWNER_CHANGE_TIMEOUT_MS = 90_000

export function cloudWorkspaceOwnerChangeMethods(call: Call) {
  return {
    async changeOwner(id: string, ownerUserId: string): Promise<OwnerChange> {
      const answer = await call(
        'PATCH',
        `/v1/team/workspaces/${encodeURIComponent(id)}`,
        OwnerChangeResponseSchema,
        { ownerUserId },
        OWNER_CHANGE_TIMEOUT_MS
      )
      return { workspace: answer.workspace, previousOwner: answer.previousOwner ?? null }
    },
    /** The caller's own notices in the team they are signed in to, newest first. */
    async ownerNotices(): Promise<OwnerChangeNotice[]> {
      return (await call('GET', '/v1/team/notices', OwnerChangeNoticeListSchema)).notices
    },
    async dismissOwnerNotice(id: string): Promise<void> {
      await call(
        'POST',
        `/v1/team/notices/${encodeURIComponent(id)}/dismiss`,
        OwnerChangeNoticeDismissedSchema,
        {}
      )
    }
  }
}
