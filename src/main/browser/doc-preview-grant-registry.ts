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
  /** Directory relative preview URLs resolve against. */
  requestBase: string
  /**
   * Containing directory of the opened document, on the owning host. It carries silent read
   * authority only while it sits strictly inside `requestBase`: a document at the workspace root —
   * or outside any workspace, where its directory IS the request base — starts with the entry file
   * alone, because that directory is where secrets live and a DNS-prefetch beacon needs no click.
   */
  root: string
  /** Additional directories the reader approved for this grant. */
  authorizedRoots: string[]
  /** Path of the opened document relative to `requestBase`. */
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
  requestBase?: string
  root: string
  entryRelativePath: string
  browserPageId: string
}): DocPreviewGrant {
  const requestBase = normalizeRootPath(params.requestBase ?? params.root)
  const root = normalizeRootPath(params.root)
  const flavor = pathFlavorFor(requestBase)
  if (!isAtOrInsideRoot(requestBase, root, flavor)) {
    throw new Error('Document preview root is outside its request base')
  }
  const grant: DocPreviewGrant = {
    id: randomBytes(16).toString('hex'),
    owner: params.owner,
    requestBase,
    root,
    authorizedRoots: [],
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

/** Resolves a safe request inside the workspace boundary, before grant authorization. */
export function resolveDocPreviewCandidatePath(
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
  const flavor = pathFlavorFor(grant.requestBase)
  const resolved = flavor.normalize(flavor.join(grant.requestBase, ...segments))
  return isInsideRoot(grant.requestBase, resolved, flavor) ? resolved : null
}

function isInsideRoot(
  root: string,
  candidate: string,
  flavor: typeof posix | typeof win32
): boolean {
  const rootPrefix = root.endsWith(flavor.sep) ? root : `${root}${flavor.sep}`
  return candidate.startsWith(rootPrefix)
}

function isAtOrInsideRoot(
  root: string,
  candidate: string,
  flavor: typeof posix | typeof win32
): boolean {
  return candidate === root || isInsideRoot(root, candidate, flavor)
}

function directoryAuthorityRoots(grant: DocPreviewGrant): string[] {
  return grant.root === grant.requestBase
    ? [...grant.authorizedRoots]
    : [grant.root, ...grant.authorizedRoots]
}

export function resolveDocPreviewAuthorityPaths(grant: DocPreviewGrant): {
  entryPath: string | null
  implicitRootPath: string | null
  authorizedRootPaths: string[]
} {
  return {
    entryPath: resolveEntryAbsolutePath(grant),
    implicitRootPath: grant.root === grant.requestBase ? null : grant.root,
    authorizedRootPaths: [...grant.authorizedRoots]
  }
}

/** The one path an entry-only grant can read before the reader approves a directory. */
function resolveEntryAbsolutePath(grant: DocPreviewGrant): string | null {
  return resolveDocPreviewCandidatePath(grant, grant.entryRelativePath)
}

/** Resolves a request only when it is the entry document or its directory is authorized. */
export function resolveDocPreviewTargetPath(
  grant: DocPreviewGrant,
  relativePath: string
): string | null {
  const resolved = resolveDocPreviewCandidatePath(grant, relativePath)
  if (!resolved) {
    return null
  }
  if (resolved === resolveEntryAbsolutePath(grant)) {
    return resolved
  }
  const flavor = pathFlavorFor(grant.requestBase)
  return directoryAuthorityRoots(grant).some((root) => isInsideRoot(root, resolved, flavor))
    ? resolved
    : null
}

/** Expands a live grant to the directory containing one reader-approved request. */
export function authorizeDocPreviewDirectory(grantId: string, relativePath: string): boolean {
  const grant = grantsById.get(grantId)
  if (!grant) {
    return false
  }
  const candidate = resolveDocPreviewCandidatePath(grant, relativePath)
  if (!candidate) {
    return false
  }
  const flavor = pathFlavorFor(grant.requestBase)
  const directory = normalizeRootPath(flavor.dirname(candidate))
  if (!isAtOrInsideRoot(grant.requestBase, directory, flavor)) {
    return false
  }
  if (!directoryAuthorityRoots(grant).some((root) => isAtOrInsideRoot(root, directory, flavor))) {
    grant.authorizedRoots.push(directory)
    canonicalRootByGrantId.delete(grant.id)
  }
  return true
}

/** Why: realpath is a host round-trip, and a grant's root is fixed for its lifetime. */
const canonicalRootByGrantId = new Map<
  string,
  Promise<{ boundary: string; roots: string[]; entry: string | null }>
>()

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
    let canonicalRoots = canonicalRootByGrantId.get(grant.id)
    if (!canonicalRoots) {
      const entryAbsolute = resolveEntryAbsolutePath(grant)
      canonicalRoots = Promise.all([
        realpath(grant.requestBase),
        entryAbsolute === null ? Promise.resolve(null) : realpath(entryAbsolute),
        ...directoryAuthorityRoots(grant).map((root) => realpath(root))
      ]).then(([boundaryPath, entryPath, ...rootPaths]) => {
        const boundary = normalizeRootPath(boundaryPath)
        const flavor = pathFlavorFor(boundary)
        return {
          boundary,
          roots: rootPaths
            .map(normalizeRootPath)
            .filter((root) => isAtOrInsideRoot(boundary, root, flavor)),
          entry: entryPath !== null && isInsideRoot(boundary, entryPath, flavor) ? entryPath : null
        }
      })
      canonicalRootByGrantId.set(grant.id, canonicalRoots)
    }
    const [{ boundary, roots, entry }, canonicalPath] = await Promise.all([
      canonicalRoots,
      realpath(absolutePath)
    ])
    const flavor = pathFlavorFor(boundary)
    return isInsideRoot(boundary, canonicalPath, flavor) &&
      (canonicalPath === entry || roots.some((root) => isInsideRoot(root, canonicalPath, flavor)))
      ? canonicalPath
      : null
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

export function toRuntimeWorktreeRelativeDirectoryPath(
  worktreeRoot: string,
  absolutePath: string
): string | null {
  const normalizedRoot = normalizeRootPath(worktreeRoot)
  return normalizeRootPath(absolutePath) === normalizedRoot
    ? ''
    : toRuntimeWorktreeRelativePath(worktreeRoot, absolutePath)
}
