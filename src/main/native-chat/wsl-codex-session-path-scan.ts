import { findWslSessionPath } from './wsl-session-path-scan'

/** Preserve the Codex-specific API while Claude shares the underlying WSL scan. */
export function findWslCodexSessionPath(
  root: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<string | null> {
  return findWslSessionPath('codex', root, sessionId, signal)
}
