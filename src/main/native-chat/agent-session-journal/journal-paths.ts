// Where a session journal lives.
//
// Host-side per-workspace state, keyed by workspace id — never inside the
// user's working tree. A journal in the tree would show up in `git status`,
// vanish with `git worktree remove`, and have no defined home in a folder
// workspace that is not a repository at all. Keying by id rather than by path
// makes a worktree, a folder workspace, a WSL distro, and an SSH host identical.
//
// `app` is imported lazily so the store stays usable from tests and from the
// headless/SSH runtime, which have no Electron app object.

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'

const JOURNAL_DIR_NAME = 'agent-session-journal'

/** Filesystem-safe, collision-resistant segment for an arbitrary id. Ids come
 *  from providers and workspaces and can contain path separators or characters
 *  Windows rejects, so they are hashed rather than sanitized. */
export function journalPathSegment(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

/** `<root>/agent-session-journal/<workspace>/<session>`. */
export function journalDirectoryFor(
  root: string,
  identity: Pick<AgentSessionJournalIdentity, 'workspaceId' | 'sessionId'>
): string {
  return join(
    root,
    JOURNAL_DIR_NAME,
    journalPathSegment(identity.workspaceId),
    journalPathSegment(identity.sessionId)
  )
}

/** Default host state root. Electron is required lazily so importing this
 *  module from a non-Electron runtime does not pull the whole app in. */
export async function defaultJournalRoot(): Promise<string> {
  const { app } = await import('electron')
  return app.getPath('userData')
}
