import { win32 } from 'node:path'
import { GROK_CHAT_HISTORY_FILE } from '../../shared/grok-session-paths'
import { OMP_SESSION_ARTIFACT_DIR_PATTERN } from '../ai-vault/session-scanner-omp-subagent-transcripts'

export type SessionIdLookupAgent = 'claude' | 'codex' | 'grok' | 'omp'

/** How one agent names a session's transcript file, for lookup by session id. */
export type SessionFileIdLayout = {
  fileMatchesId: (path: string, sessionId: string) => boolean
  /** False skips a directory while looking for any id `wanted` accepts; depth 0 is a root child. */
  directoryPredicate?: (name: string, depth: number, wanted: (id: string) => boolean) => boolean
}

// win32 path parsing splits on both separators, so host and `\\wsl.localhost` paths match alike.
function stem(path: string): string {
  return win32.basename(path, win32.extname(path))
}

export const SESSION_FILE_ID_LAYOUTS: Record<SessionIdLookupAgent, SessionFileIdLayout> = {
  // `<projects>/<slug>/<id>.jsonl`
  claude: { fileMatchesId: (path, id) => win32.basename(path) === `${id}.jsonl` },
  // `rollout-<ts>-<id>.jsonl`, date-nested
  codex: {
    fileMatchesId: (path, id) => {
      const name = stem(path)
      return name === id || name.endsWith(`-${id}`)
    }
  },
  // `<sessions>/<cwd group>/<id>/chat_history.jsonl`
  grok: {
    fileMatchesId: (path, id) =>
      win32.basename(path) === GROK_CHAT_HISTORY_FILE && win32.basename(win32.dirname(path)) === id,
    directoryPredicate: (name, depth, wanted) => depth === 0 || (depth === 1 && wanted(name))
  },
  // `<sessions>/<cwd dir>/<ISO stamp>_<id>.jsonl`
  omp: {
    fileMatchesId: (path, id) => {
      const name = stem(path)
      return name === id || name.endsWith(`_${id}`)
    },
    // Why: a session's subagent transcripts live in its same-named `<stamp>_<uuid>/`
    // artifact dir, and one can end in `_<session id>` too — so descending would let
    // it win the suffix match over its own parent. Same prune as AI Vault discovery.
    directoryPredicate: (name, depth) => depth === 0 || !OMP_SESSION_ARTIFACT_DIR_PATTERN.test(name)
  }
}
