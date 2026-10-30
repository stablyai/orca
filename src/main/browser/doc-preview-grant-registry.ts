import { randomBytes } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'

export type DocPreviewOwner =
  | { kind: 'ssh'; connectionId: string }
  | {
      kind: 'runtime'
      environmentId: string
      worktreeSelector: string
      /** File reads are scoped to this root on the runtime host. */
      worktreeRoot: string
    }

export type DocPreviewGrant = {
  id: string
  owner: DocPreviewOwner
  /** Base directory for relative preview URLs. */
  requestBase: string
  /** Document directory; implicit access excludes requestBase to protect neighboring secrets. */
  root: string
  authorizedRoots: string[]
  entryRelativePath: string
  /** Stable tool target across grant replacements for the same preview page. */
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
  // Preserve drive-root separators: C: is drive-relative, whereas C:\ is absolute.
  if (flavor === win32 && /^[a-zA-Z]:\\$/.test(normalized)) {
    return normalized
  }
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

// Revocation lets grab and other page-scoped state release entries before guest teardown.
const revocationListeners = new Set<(grant: DocPreviewGrant) => void>()

/** Listeners receive the removed grant because it is no longer in the registry. */
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

/** Resolves within the workspace boundary without granting read access. */
export function resolveDocPreviewCandidatePath(
  grant: DocPreviewGrant,
  relativePath: string
): string | null {
  const segments = relativePath.split('/').filter((segment, index, all) => {
    // Preserve internal empty segments for validation; allow a trailing slash.
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

function resolveEntryAbsolutePath(grant: DocPreviewGrant): string | null {
  return resolveDocPreviewCandidatePath(grant, grant.entryRelativePath)
}

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

// Cache canonical authority paths until revocation or a directory-authorization change.
const canonicalRootByGrantId = new Map<
  string,
  Promise<{ boundary: string; roots: string[]; entry: string | null }>
>()

// Canonicalize on the owning host to catch symlinks that escape lexical containment.
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
    // Canonicalization failure must not fall back to lexical containment.
    canonicalRootByGrantId.delete(grant.id)
    return null
  }
}

/** Returns null for the worktree root itself or files outside it. */
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
