/**
 * Canonicalising the one path every office operation is keyed by.
 *
 * Two separate reasons this is not optional:
 *
 *  - `officecli unwatch <f>` matches the literal spelling `watch <f>` was given. A watch started
 *    from a relative path cannot be stopped by an absolute one — verified against 1.0.148, where
 *    unwatch answers "No watch running" and the server keeps listening. Teardown depends on both
 *    calls agreeing on one string.
 *  - Two opens of one document under different spellings would start two watch sessions, and the
 *    second hits the tool's one-watch-per-file refusal for no reason the reader can see.
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { joinOfficeRelativePath } from '../../shared/office-preview-rpc'
import { runWslProcess } from '../wsl/wsl-runner'
import type { OfficecliLane } from './officecli-lane'

export class OfficeDocumentPathError extends Error {
  constructor(readonly path: string) {
    super(`Office document path is not addressable on its host: ${path}`)
    this.name = 'OfficeDocumentPathError'
  }
}

/** A document the caller named that does not live inside the workspace it named. */
export class OfficeDocumentOutsideWorkspaceError extends Error {
  constructor(readonly path: string) {
    super(`Office document path is outside the workspace that was named: ${path}`)
    this.name = 'OfficeDocumentOutsideWorkspaceError'
  }
}

/**
 * The one path every office operation runs against: a workspace root plus a path relative to it,
 * joined and canonicalised on the host, then proved to still sit inside that root.
 *
 * Why the host re-checks something the caller already composed: every neighbouring runtime
 * `files.*` method is `(worktree, relativePath)` and resolves on the host, and the SSH relay's
 * `readAuthorizedDocPreviewFile` does exactly this — canonicalise both ends, then
 * `isPathInsideOrEqual`. Symlink resolution is why the check has to come *after* canonicalising:
 * a link inside the workspace can point anywhere, so a lexical join proves nothing.
 */
export async function resolveOfficeDocumentTarget(
  workspaceRoot: string,
  relativePath: string,
  lane: OfficecliLane
): Promise<string> {
  const joined = joinOfficeRelativePath(workspaceRoot, relativePath)
  if (!joined) {
    throw new OfficeDocumentPathError(relativePath)
  }
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalOfficeDocumentPath(workspaceRoot, lane),
    canonicalOfficeDocumentPath(joined, lane)
  ])
  if (!isPathInsideOrEqual(canonicalRoot, canonicalTarget)) {
    throw new OfficeDocumentOutsideWorkspaceError(relativePath)
  }
  return canonicalTarget
}

/**
 * Absolute, symlink-resolved path on the lane's own filesystem.
 *
 * A path that cannot be canonicalised is refused rather than passed through: an uncanonicalised
 * path is exactly the one that breaks teardown, and a document we cannot address is not one we
 * should hand to a spawn.
 */
export async function canonicalOfficeDocumentPath(
  documentPath: string,
  lane: OfficecliLane
): Promise<string> {
  const trimmed = documentPath.trim()
  if (!trimmed || trimmed.includes('\0')) {
    throw new OfficeDocumentPathError(documentPath)
  }
  if (lane.kind === 'wsl') {
    if (!trimmed.startsWith('/')) {
      throw new OfficeDocumentPathError(documentPath)
    }
    const result = await runWslProcess({
      script: 'readlink -f -- "$1" 2>/dev/null || true',
      args: [trimmed],
      distro: lane.distro,
      loginPath: 'none',
      timeoutMs: 8_000
    })
    const canonical = result.stdout.split(/\r?\n/).find((line) => line.startsWith('/'))
    if (!canonical) {
      throw new OfficeDocumentPathError(documentPath)
    }
    return canonical
  }
  if (!isAbsolute(trimmed)) {
    throw new OfficeDocumentPathError(documentPath)
  }
  try {
    return await realpath(resolve(trimmed))
  } catch {
    throw new OfficeDocumentPathError(documentPath)
  }
}

/**
 * Session key: one watch per (execution host, canonical path).
 *
 * A JSON tuple rather than a delimiter-joined string, matching
 * `localSshBrowserAuthorityConnectionIdentity`. A plain separator has to be a character that can
 * appear in neither half or two different pairs can collide; the previous NUL byte bought that at
 * the cost of making this whole module binary to Git — `git diff`, `git blame` and `grep` all gave
 * up on it, which is how a path-handling module ends up unreviewable.
 */
export function officeSessionKey(hostKey: string, canonicalPath: string): string {
  // Normalised rather than compared raw, because the two producers of this key cannot be relied on
  // to spell one path the same way: `startOfficeWatch` keys on `realpath`, while the stop path
  // falls back to a lexical join when the document has since been deleted. On Windows those two
  // differ by separator alone (`C:\repo\a.docx` vs `C:\repo/a.docx`) and the lookup would miss,
  // leaking the watch process and its port until app quit.
  //
  // It also has to be the *path* that decides case-folding, not this process's platform: a WSL
  // lane on a Windows host hands us a guest path on a case-sensitive filesystem, where lowercasing
  // would merge `/home/me/Repo` and `/home/me/repo` into one session and show the wrong document.
  return JSON.stringify([hostKey, normalizeRuntimePathForComparison(canonicalPath)])
}
