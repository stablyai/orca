// Claude stores manual and generated titles in independent transcript slots.
import { normalizeTitleText, parseJsonObject } from '../ai-vault/session-scanner-values'
import {
  claudeTranscriptTailLines,
  type ClaudeTranscriptTailScan
} from './claude-transcript-tail-scan'

/** The effective name stored in the transcript. */
export type ClaudeTranscriptConversationName =
  | { kind: 'named'; title: string }
  /** The newest title record positively removes the name, and the whole file
   *  was visible, so there is no older generated name to fall back to. */
  | { kind: 'cleared' }
  /** No readable title record was found. */
  | { kind: 'unknown' }

/**
 * The transcript's stored name.
 *
 * A user's own `custom-title` outranks the generated `ai-title`, matching the
 * precedence the CLI itself applies — including when the custom slot is EMPTY,
 * which falls back to the generated name rather than reading as no name at all.
 * Only an emptied custom slot with nothing to fall back to is a clear.
 *
 * Read newest-first, so the first record of each type is the current one.
 *
 * Fails closed on a shape it cannot read: a `custom-title` whose field is absent,
 * null, or renamed by a future CLI is skipped, never taken as a deliberate clear.
 * Wrongly clearing destroys a name the user can still see in their CLI.
 */
export async function readClaudeTranscriptConversationName(
  transcriptPath: string
): Promise<ClaudeTranscriptConversationName> {
  let generated: string | null = null
  let customCleared = false
  const scan: ClaudeTranscriptTailScan = { reachedFileStart: false }
  for await (const line of claudeTranscriptTailLines(transcriptPath, scan, Infinity)) {
    if (!line.includes('-title')) {
      continue
    }
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }
    if (record.type === 'custom-title' && !customCleared) {
      if (typeof record.customTitle !== 'string') {
        continue
      }
      const title = normalizeTitleText(record.customTitle)
      if (title) {
        return { kind: 'named', title }
      }
      customCleared = true
      continue
    }
    if (record.type === 'ai-title' && !generated) {
      // Guarded, not coerced: `String(someObject)` yields `[object Object]`,
      // which passes every downstream check and becomes the tab's label.
      if (typeof record.aiTitle !== 'string') {
        continue
      }
      generated = normalizeTitleText(record.aiTitle)
    }
  }
  if (generated && (customCleared || scan.reachedFileStart)) {
    return { kind: 'named', title: generated }
  }
  // A truncated read cannot establish that no generated fallback exists.
  return customCleared && scan.reachedFileStart ? { kind: 'cleared' } : { kind: 'unknown' }
}

/** The adapter's own dep bag, which names this reporter's error hook differently.
 *  Mapped rather than passed by reference: an undeclared key survives only while
 *  the object happens to be handed over whole, and typecheck cannot see it go. */
export type ClaudeConversationNameReporterSource = ClaudeConversationNameReporter & {
  onNamingError?: (scope: string, error: unknown) => void
}

export function claudeConversationNameReporterDeps(
  source: ClaudeConversationNameReporterSource
): ClaudeConversationNameReporter {
  return {
    ...(source.readTranscriptConversationName
      ? { readTranscriptConversationName: source.readTranscriptConversationName }
      : {}),
    ...(source.onConversationName ? { onConversationName: source.onConversationName } : {}),
    ...(source.onConversationNameCleared
      ? { onConversationNameCleared: source.onConversationNameCleared }
      : {}),
    ...((source.onError ?? source.onNamingError)
      ? { onError: (source.onError ?? source.onNamingError)! }
      : {})
  }
}

export type ClaudeConversationNameReporter = {
  readTranscriptConversationName?: (input: {
    providerSessionId: string
    claudeConfigDir: string
  }) => Promise<ClaudeTranscriptConversationName>
  onConversationName?: (sessionId: string, conversationName: string) => void
  onConversationNameCleared?: (sessionId: string) => void
  onError?: (scope: string, error: unknown) => void
}

/**
 * Reports the name Claude persisted for a session that just went live.
 *
 * Deliberately not awaited: an unreadable or unnamed transcript must leave the
 * chat on its placeholder label rather than delay or fail the acquisition.
 */
export function reportPersistedClaudeConversationName(
  sessionId: string,
  session:
    | { providerSessionId: string; claudeConfigDir: string; namingAttempted?: boolean }
    | undefined,
  source: ClaudeConversationNameReporterSource,
  isCurrent: () => boolean = () => true
): Promise<ClaudeTranscriptConversationName> {
  const deps = claudeConversationNameReporterDeps(source)
  const read = deps.readTranscriptConversationName
  if (!session || !read || !deps.onConversationName) {
    return Promise.resolve({ kind: 'unknown' })
  }
  return read({
    providerSessionId: session.providerSessionId,
    claudeConfigDir: session.claudeConfigDir
  })
    .then((found) => {
      if (!isCurrent()) {
        return { kind: 'unknown' as const }
      }
      if (found.kind === 'cleared') {
        // The user deleted the name in the CLI; a stale one here keeps rendering.
        // Marked attempted for the same reason the durable clear is: their next
        // message must not quietly generate a replacement.
        session.namingAttempted = true
        deps.onConversationNameCleared?.(sessionId)
        return found
      }
      if (found.kind !== 'named') {
        return found
      }
      // A transcript that already holds a name is a conversation that is already
      // named; nothing should generate another one for it.
      session.namingAttempted = true
      deps.onConversationName?.(sessionId, found.title)
      return found
    })
    .catch((error: unknown) => {
      deps.onError?.('claude-transcript-name', error)
      return { kind: 'unknown' as const }
    })
}
