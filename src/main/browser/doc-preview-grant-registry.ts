import { randomBytes } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'

/**
 * A preview grant is the only authority that turns an `orca-preview://` request
 * into bytes: it names the host that owns the file and the single directory
 * subtree requests may resolve inside. No grant, no bytes.
 */
export type DocPreviewOwner =
  | { kind: 'ssh'; connectionId: string }
  | {
      kind: 'runtime'
      environmentId: string
      /** Selector the runtime resolves `files.read` against. */
      worktreeSelector: string
      /** Worktree root on the runtime host; `files.read` only accepts paths inside it. */
      worktreeRoot: string
    }

export type DocPreviewGrant = {
  id: string
  owner: DocPreviewOwner
  /** Containing directory of the opened document, on the owning host. */
  root: string
  /** Path of the opened document relative to `root`. */
  entryRelativePath: string
  /**
   * Browser page the reader opened this document in. Main registers the guest under it once the
   * guest commits to the grant, so the surface a tool names is the page the reader is looking at
   * and not the grant, which a re-mint replaces underneath the same page.
   */
  browserPageId: string
}

const grantsById = new Map<string, DocPreviewGrant>()

function pathFlavorFor(root: string): typeof posix | typeof win32 {
  return isWindowsAbsolutePathLike(root) ? win32 : posix
}

function normalizeRootPath(root: string): string {
  const flavor = pathFlavorFor(root)
  const normalized =
    flavor === win32 ? flavor.normalize(root.replace(/\//g, '\\')) : flavor.normalize(root)
  // Why: `C:\` is the whole root, and trimming its separator would make win32.join answer the
  // drive-relative `C:x`, which resolves against the host's cwd instead of inside the grant.
  if (flavor === win32 && /^[a-zA-Z]:\\$/.test(normalized)) {
    return normalized
  }
  // Why: a trailing separator would make the containment prefix check accept a sibling directory.
  return normalized.length > 1 && normalized.endsWith(flavor.sep)
    ? normalized.slice(0, -1)
    : normalized
}

export function mintDocPreviewGrant(params: {
  owner: DocPreviewOwner
  root: string
  entryRelativePath: string
  browserPageId: string
}): DocPreviewGrant {
  const grant: DocPreviewGrant = {
    id: randomBytes(16).toString('hex'),
    owner: params.owner,
    root: normalizeRootPath(params.root),
    entryRelativePath: params.entryRelativePath.replace(/\\/g, '/'),
    browserPageId: params.browserPageId
  }
  grantsById.set(grant.id, grant)
  return grant
}

export function getDocPreviewGrant(grantId: string): DocPreviewGrant | null {
  return grantsById.get(grantId) ?? null
}

/**
 * Why anything listens at all: a grant is the only thing that names a preview's lifetime. State
 * elsewhere in main keyed by a preview's tool target — grab intent, a queued grab chain — has no
 * other signal telling it the surface is gone, and would otherwise accrete one entry per grant
 * for the life of the process.
 */
const revocationListeners = new Set<(grant: DocPreviewGrant) => void>()

/** Why the whole grant and not its id: it is already gone from the registry when listeners run. */
export function onDocPreviewGrantRevoked(listener: (grant: DocPreviewGrant) => void): () => void {
  revocationListeners.add(listener)
  return () => revocationListeners.delete(listener)
}

function notifyRevoked(grant: DocPreviewGrant): void {
  for (const listener of revocationListeners) {
    listener(grant)
  }
}

export function revokeDocPreviewGrant(grantId: string): boolean {
  canonicalRootByGrantId.delete(grantId)
  const grant = grantsById.get(grantId)
  if (!grant) {
    return false
  }
  grantsById.delete(grantId)
  notifyRevoked(grant)
  return true
}

export function revokeAllDocPreviewGrants(): void {
  canonicalRootByGrantId.clear()
  const revoked = [...grantsById.values()]
  grantsById.clear()
  for (const grant of revoked) {
    notifyRevoked(grant)
  }
}

function hasUnsafeSegment(segments: string[]): boolean {
  return segments.some(
    (segment) =>
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\0') ||
      segment.includes('\\')
  )
}

/**
 * Resolves a request path to an absolute path on the owning host, or null when
 * it would escape the grant's root. Path flavor follows the root (the owning
 * host may be Windows while this client is not), never `process.platform`.
 */
export function resolveDocPreviewTargetPath(
  grant: DocPreviewGrant,
  relativePath: string
): string | null {
  const segments = relativePath.split('/').filter((segment, index, all) => {
    // Why: keep empty segments visible to the safety check except a single trailing one from `dir/`.
    return !(segment === '' && index === all.length - 1)
  })
  if (segments.length === 0 || hasUnsafeSegment(segments)) {
    return null
  }
  const flavor = pathFlavorFor(grant.root)
  const resolved = flavor.normalize(flavor.join(grant.root, ...segments))
  return isInsideRoot(grant.root, resolved, flavor) ? resolved : null
}

function isInsideRoot(
  root: string,
  candidate: string,
  flavor: typeof posix | typeof win32
): boolean {
  const rootPrefix = root.endsWith(flavor.sep) ? root : `${root}${flavor.sep}`
  return candidate.startsWith(rootPrefix)
}

/** Why: realpath is a host round-trip, and a grant's root is fixed for its lifetime. */
const canonicalRootByGrantId = new Map<string, Promise<string>>()

/**
 * Second containment pass for hosts where the lexical one is not enough: a symlink
 * inside the root can point anywhere, and the SSH read RPC applies no root of its
 * own. Both sides are canonicalized on the owning host before the prefix re-check;
 * a host that cannot canonicalize a path answers nothing.
 */
export async function resolveCanonicalDocPreviewPath(
  grant: DocPreviewGrant,
  absolutePath: string,
  realpath: (path: string) => Promise<string>
): Promise<string | null> {
  try {
    let canonicalRoot = canonicalRootByGrantId.get(grant.id)
    if (!canonicalRoot) {
      canonicalRoot = realpath(grant.root).then(normalizeRootPath)
      canonicalRootByGrantId.set(grant.id, canonicalRoot)
    }
    const [root, canonicalPath] = await Promise.all([canonicalRoot, realpath(absolutePath)])
    const flavor = pathFlavorFor(root)
    return isInsideRoot(root, canonicalPath, flavor) ? canonicalPath : null
  } catch {
    // Why: a root that no longer canonicalizes must not fall back to the lexical answer.
    canonicalRootByGrantId.delete(grant.id)
    return null
  }
}

/**
 * Path a runtime `files.read` can address, i.e. relative to the worktree root.
 * Returns null when the grant root sits outside the worktree — the runtime file
 * RPCs are worktree-scoped, so those documents are unreadable client-side.
 */
export function toRuntimeWorktreeRelativePath(
  worktreeRoot: string,
  absolutePath: string
): string | null {
  const flavor = pathFlavorFor(worktreeRoot)
  const normalizedRoot = normalizeRootPath(worktreeRoot)
  const relative = flavor.relative(normalizedRoot, absolutePath)
  if (!relative || relative === '..' || relative.startsWith(`..${flavor.sep}`)) {
    return null
  }
  if (flavor === win32 && /^[a-zA-Z]:/.test(relative)) {
    return null
  }
  return relative.replace(/\\/g, '/')
}
