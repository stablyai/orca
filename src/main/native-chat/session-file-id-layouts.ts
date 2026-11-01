import { win32 } from 'node:path'
import { GROK_CHAT_HISTORY_FILE } from '../../shared/grok-session-paths'
import { isOmpConversationDirectory } from '../ai-vault/session-scanner-omp-subagent-transcripts'

export type SessionIdLookupAgent = 'claude' | 'codex' | 'grok' | 'omp'

export type SessionFileIdLayout = {
  fileMatchesId: (path: string, sessionId: string) => boolean
  /** depth 0 is a direct root child; false prunes this directory. */
  directoryPredicate?: (name: string, depth: number, wanted: (id: string) => boolean) => boolean
}

// win32 parsing handles both native and WSL UNC separators.
function stem(path: string): string {
  return win32.basename(path, win32.extname(path))
}

export const SESSION_FILE_ID_LAYOUTS: Record<SessionIdLookupAgent, SessionFileIdLayout> = {
  claude: { fileMatchesId: (path, id) => win32.basename(path) === `${id}.jsonl` },
  codex: {
    fileMatchesId: (path, id) => {
      const name = stem(path)
      return name === id || name.endsWith(`-${id}`)
    }
  },
  grok: {
    fileMatchesId: (path, id) =>
      win32.basename(path) === GROK_CHAT_HISTORY_FILE && win32.basename(win32.dirname(path)) === id,
    directoryPredicate: (name, depth, wanted) => depth === 0 || (depth === 1 && wanted(name))
  },
  omp: {
    fileMatchesId: (path, id) => {
      const name = stem(path)
      return name === id || name.endsWith(`_${id}`)
    },
    // Prune subagent artifact directories: their suffix can match the parent ID and steal its transcript.
    directoryPredicate: isOmpConversationDirectory
  }
}
