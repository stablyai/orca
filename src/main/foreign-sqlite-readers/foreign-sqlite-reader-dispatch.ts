import type {
  ForeignSqliteReaderRequest,
  ForeignSqliteReaderResponse
} from './foreign-sqlite-reader-protocol'
import { readCursorProfile } from './readers/cursor-profile'
import { readOpenCodeBinderSessions } from './readers/opencode-binder-sessions'
import { readOpenCodePromptFailure } from './readers/opencode-prompt-failure'

/** Structured-clone requests may carry unknown kinds despite the static type. */
export function handleForeignSqliteReaderRequest(
  request: ForeignSqliteReaderRequest
): ForeignSqliteReaderResponse {
  // Destructuring here preserves request narrowing through kind and exhaustiveness at never.
  const { id, kind } = request
  try {
    switch (kind) {
      case 'cursorProfile':
        return { id, ok: true, value: readCursorProfile(request.dbPath) }
      case 'openCodeBinderSessions':
        return { id, ok: true, value: readOpenCodeBinderSessions(request.dbPath, request.cursor) }
      case 'openCodePromptFailure':
        return { id, ok: true, value: readOpenCodePromptFailure(request) }
    }
    return unknownKind(id, kind)
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// never makes new unhandled request kinds a compile error.
function unknownKind(id: number, kind: never): ForeignSqliteReaderResponse {
  return { id, ok: false, error: `Unknown foreign SQLite reader kind: ${String(kind)}` }
}
