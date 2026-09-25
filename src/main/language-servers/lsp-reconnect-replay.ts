// Reconnect replay for SSH LSP sessions (spec §6 + ticket 17): when a transport
// drop kills a session (verdict `unverifiable`), a successful reconnect spawns a
// fresh clangd and replays `didOpen` for every currently-open document so
// navigation recovers without the user re-opening each tab. Pure + unit-tested:
// given the retained open-document set and a fresh session, assert the replay
// sequence (didOpen per doc, in insertion order) and that a died session's
// documents are not lost on respawn.
//
// The retained set is host-owned (the session entry keeps it across a died
// session so the respawn can replay it); the renderer's document-sync bridge is
// not involved in the replay — it already believes the documents are open.

export type RetainedOpenDocument = {
  filePath: string
  text: string
  /** Monotonic per-document version the renderer owned; replayed didOpen resets to 1. */
  version: number
}

/** Build the session key for a worktree on a host. SSH worktrees are prefixed
 *  with the target id so two SSH hosts sharing a POSIX path don't collide
 *  (execution-boundary: no silent substitution). Local + WSL use the bare path. */
export function sessionKeyFor(
  worktreeRoot: string,
  sshTargetId: string | null,
  normalizeFn: (filePath: string) => string
): string {
  const base = normalizeFn(worktreeRoot)
  return sshTargetId ? `ssh:${sshTargetId}|${base}` : base
}

/**
 * Replay didOpen for every retained open document against a fresh session.
 * Returns the count of documents replayed. The session is responsible for
 * re-establishing its own document table; this only drives the LSP `didOpen`
 * notifications (clangd rebuilds its AST from the text).
 */
export function replayOpenDocuments(
  session: { didOpen(filePath: string, text: string): void },
  documents: readonly RetainedOpenDocument[]
): number {
  let replayed = 0
  for (const doc of documents) {
    session.didOpen(doc.filePath, doc.text)
    replayed += 1
  }
  return replayed
}

/** Capture a session's open documents for respawn replay (spec §6 + ticket 17).
 *  Owns the retained set so the host stays lean — call `captureOnExit` from the
 *  session's onExit, and `replayOnRespawn` from the startPromise resolution. */
export class SessionRespawnReplay {
  private readonly retained = new Map<string, RetainedOpenDocument[]>()

  /** Retain the open-document texts before the session is dropped. No-op when empty. */
  captureOnExit(key: string, openDocumentTexts: Map<string, string>): void {
    if (openDocumentTexts.size === 0) {
      return
    }
    const retained: RetainedOpenDocument[] = []
    for (const [docPath, docText] of openDocumentTexts) {
      retained.push({ filePath: docPath, text: docText, version: 1 })
    }
    this.retained.set(key, retained)
  }

  /** Replay didOpen for retained docs against a fresh session; re-establishes the
   *  document→session mapping so sessionForDocument resolves post-replay. Returns the count. */
  replayOnRespawn(
    session: { didOpen(filePath: string, text: string): void },
    key: string,
    entry: { openDocuments: Set<string>; openDocumentTexts: Map<string, string> },
    sessionKeyByDocument: Map<string, string>,
    normalizeFn: (filePath: string) => string,
    onLog?: (count: number) => void
  ): number {
    const retained = this.retained.get(key)
    if (!retained || retained.length === 0) {
      return 0
    }
    for (const doc of retained) {
      const docKey = normalizeFn(doc.filePath)
      entry.openDocuments.add(docKey)
      entry.openDocumentTexts.set(docKey, doc.text)
      sessionKeyByDocument.set(docKey, key)
    }
    const count = replayOpenDocuments(session, retained)
    this.retained.delete(key)
    onLog?.(count)
    return count
  }
}

/**
 * Derive the reconnect verdict for a session whose transport was lost. Pure
 * mapping so the host's respawn path can assert: a transport-loss exit is
 * `unverifiable` (never `exited`), and a reconnect that respawns transitions
 * it to a fresh live session (the old session is killed, never reattached —
 * `lsp.attach` lease is a v2 optimization, spec D6).
 */
export function reconnectVerdict(
  exitError: (Error & { code?: string }) | null
): 'unverifiable' | 'exited' | 'clean' {
  if (exitError === null) {
    return 'clean'
  }
  // A transport-loss error is unverifiable; anything else is a host-acknowledged
  // exit (the relay observed the child terminate).
  if (exitError.code === 'CONNECTION_LOST' || exitError.name === 'SshLspTransportLostError') {
    return 'unverifiable'
  }
  return 'exited'
}
