import { realpath } from 'node:fs/promises'
import { fileUriToFilesystemPath } from '../../shared/file-uri-path'
import { isPathInsideOrEqual, resolveRuntimePath } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { BrowserError } from '../browser/browser-error'

export type BrowserFileUrlWorktreeTarget = {
  id: string
  path?: string
  hostId?: ExecutionHostId
}

export function isBrowserFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'file:'
  } catch {
    return false
  }
}

/**
 * The one gate every paired-reachable navigation to a host-rendered page passes through.
 *
 * A paired client (phone, web client, remote desktop, remote CLI) is not trusted to name a
 * filesystem path: its `file:` URL only renders a file inside the workspace it named, on this
 * host, so the screencast that streams the render back never leaves that root. Local callers keep
 * their existing reach.
 *
 * Client placement is exempt and not a hole: that page renders on the caller's own device against
 * the caller's own disk, and browser-host-client-page-creation.ts refuses a lease whose
 * `pairedDeviceId` is not the caller's, so one device cannot make another render for it. The
 * host's workspace root is simply the wrong root to judge a read on another machine.
 */
export async function guardPairedBrowserNavigation(input: {
  url: string
  pairedCaller: boolean
  placementKind?: string
  // Lazy so an http(s) navigation never pays for a resolve, and an unresolvable selector still
  // fails the way it always did rather than as a confinement refusal.
  resolveWorktree: () => Promise<BrowserFileUrlWorktreeTarget | undefined>
}): Promise<void> {
  if (!input.pairedCaller || !isBrowserFileUrl(input.url) || input.placementKind === 'client') {
    return
  }
  await assertPairedBrowserFileUrlAllowed({
    url: input.url,
    pairedCaller: true,
    worktree: await input.resolveWorktree()
  })
}

export async function assertPairedBrowserFileUrlAllowed(input: {
  url: string
  pairedCaller: boolean
  worktree: BrowserFileUrlWorktreeTarget | undefined
}): Promise<void> {
  if (!input.pairedCaller || !isBrowserFileUrl(input.url)) {
    return
  }
  const worktree = input.worktree
  const root = worktree?.path
  if (!worktree || !root) {
    throw new BrowserError(
      'forbidden',
      'A file:// browser page requires an explicit workspace on this host.'
    )
  }
  // Why not `!== undefined &&`: an unstamped hostId is an unanswered question, and the URL is
  // about to be opened against this host's disk, where a remote workspace's path names a
  // different file (or none) than the one the caller asked for.
  if (worktree.hostId !== LOCAL_EXECUTION_HOST_ID) {
    throw new BrowserError(
      'forbidden',
      'A file:// browser page is not available for a remote workspace.'
    )
  }
  let candidate: string | null
  try {
    candidate = fileUriToFilesystemPath(new URL(input.url))
  } catch {
    candidate = null
  }
  if (!candidate || !(await resolvedPathIsInsideRoot(root, candidate))) {
    throw new BrowserError('forbidden', 'That file is outside the requested workspace.')
  }
}

/**
 * Two independent reasons a lexical prefix test is not enough, so both are closed here.
 *
 * `isPathInsideOrEqual` never collapses dot segments, and `%2f` survives the URL parser (unlike
 * `%2e`, which `new URL()` collapses for us), so `root%2f..%2f..%2fetc/hosts` decodes to a real
 * traversal that reads as inside the root. `resolveRuntimePath` collapses it before any compare,
 * and deliberately not by relying on realpath: the refusal must not depend on where the traversal
 * happens to land, or on the target existing at all.
 *
 * Symlinks are the same gap by another route, and only the filesystem can answer those, so both
 * sides then go through realpath. Requiring the target to exist is what makes a dangling link
 * refusable — its nearest existing ancestor is still inside the root.
 */
async function resolvedPathIsInsideRoot(root: string, candidate: string): Promise<boolean> {
  const collapsed = resolveRuntimePath(root, candidate)
  if (!isPathInsideOrEqual(root, collapsed)) {
    return false
  }
  try {
    return isPathInsideOrEqual(await realpath(root), await realpath(collapsed))
  } catch {
    return false
  }
}
