import { TerminalHistoryUnavailableError } from '../../protocol/daemon-history-protocol'
import { fingerprintTerminalHistorySession } from '../storage/terminal-history-recovery-quarantine'

/**
 * At most two whole acquisitions, each bracketed by a fresh fingerprint of the session's files
 * and published only if nothing changed. A source that keeps changing is unavailable for now:
 * never absent, corrupt or a reason to start fresh.
 */
export async function readTerminalHistoryCoherently<T>(
  basePath: string,
  sessionId: string,
  read: () => Promise<T>
): Promise<T> {
  const fingerprint = (): string | null | undefined => {
    try {
      return fingerprintTerminalHistorySession(basePath, sessionId)
    } catch {
      return undefined
    }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = fingerprint()
    if (before === undefined) {
      continue
    }
    const result = await read()
    if (fingerprint() === before) {
      return result
    }
  }
  throw new TerminalHistoryUnavailableError()
}
