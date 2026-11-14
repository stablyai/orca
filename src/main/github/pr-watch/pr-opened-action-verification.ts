import type { PRPendingActionResumeDeps, PRVerifiedAction } from './pr-pending-action-types'
import type { PRPendingActionRow } from './pr-pending-actions'
import type { PRChatOpened } from './pr-chat-action-recorder'
import { prWatchCandidate, type PRWatchWorkspace } from './pr-watch-types'

export async function verifyOpenedPRAction(
  deps: PRPendingActionResumeDeps,
  row: PRPendingActionRow,
  pr: PRChatOpened,
  workspace: PRWatchWorkspace
): Promise<PRVerifiedAction[]> {
  const own = (await deps.repositories(workspace)).some(
    (repo) =>
      repo.owner.toLowerCase() === pr.owner.toLowerCase() &&
      repo.repo.toLowerCase() === pr.repo.toLowerCase() &&
      (repo.host ?? 'github.com').toLowerCase() === pr.forgeHost.toLowerCase()
  )
  return own
    ? [
        {
          action: {
            chatId: row.chatId,
            anchor: row.anchor,
            ...pr,
            kind: 'opened',
            headSha: null,
            observedAt: row.finishedAt
          },
          candidate: prWatchCandidate(workspace, pr.number),
          movedAt: null
        }
      ]
    : []
}
