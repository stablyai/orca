// Folds a sleeping workspace's sealed read snapshot (Orca Cloud) into this computer's cached copy.
import type { ReadSnapshot } from '../../shared/cloud-workspaces/read-snapshot'
import type { CloudOfflineSnapshot } from '../../shared/hosted-sandbox/cloud-workspace-offline-api'

const MAX_CHANGES = 300

/**
 * Folds the workspace's own sealed sleep snapshot into this computer's cached copy: each section
 * (git, each chat) comes from whichever is newer, so the view is never older than either. The cache
 * keeps terminals (the snapshot has none); the PR only exists in the snapshot.
 */
export function mergeCloudReadSnapshot(
  local: CloudOfflineSnapshot,
  remote: ReadSnapshot
): CloudOfflineSnapshot {
  const at = remote.capturedAt
  let fromCloud = false
  let git = local.git
  if (remote.git && (!local.git || at > local.git.at)) {
    fromCloud = true
    git = {
      branch: remote.git.branch,
      head: remote.git.head,
      changes: remote.git.changes.slice(0, MAX_CHANGES).map((change) => ({ ...change })),
      changeCount: remote.git.changeCount,
      commits: remote.git.commits.map((commit) => ({ ...commit })),
      at,
      added: remote.git.added,
      removed: remote.git.removed
    }
  }
  const chats = new Map(local.chats.map((chat) => [chat.sessionId, chat]))
  for (const session of remote.sessions) {
    const known = chats.get(session.sessionId)
    // A session the snapshot saw with no messages adds nothing a cached transcript lacks.
    if (session.messages.length === 0 && known) {
      continue
    }
    if (!known || at > known.at) {
      fromCloud = true
      chats.set(session.sessionId, {
        sessionId: session.sessionId,
        at,
        messages: session.messages.map((message) => ({ ...message })),
        agent: session.agent,
        title: session.title
      })
    }
  }
  const pr = remote.pr ? { ...remote.pr } : (local.pr ?? null)
  fromCloud ||= pr !== null && local.pr == null
  const hadLocal = local.capturedAt !== null
  const times = [local.capturedAt ?? 0, fromCloud ? at : 0].filter((time) => time > 0)
  return {
    ...local,
    capturedAt: times.length > 0 ? Math.max(...times) : null,
    git,
    chats: [...chats.values()].sort((a, b) => b.at - a.at),
    pr,
    source: !fromCloud ? (local.source ?? 'device') : hadLocal ? 'mixed' : 'cloud'
  }
}
