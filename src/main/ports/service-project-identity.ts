import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_WALK_DEPTH = 24
const CACHE_TTL_MS = 10_000
const CACHE_MAX_ENTRIES = 256

export type ServiceIdentity = {
  /** Repository or project root directory, when one could be found. */
  projectRoot: string | null
  /** Human-readable project name. Null when unresolvable — never a guess. */
  projectName: string | null
  /** The app within the project, e.g. `market` inside `mono-numis-store`. */
  serviceName: string | null
}

const EMPTY_IDENTITY: ServiceIdentity = {
  projectRoot: null,
  projectName: null,
  serviceName: null
}

/**
 * Manifests that mark a project root when there is no `.git`. Ordered by how
 * strongly each implies "this is the top of a project" rather than a sub-package.
 */
const ROOT_MANIFESTS = ['go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml', 'package.json']

type CacheEntry = { value: ServiceIdentity; at: number }
const identityCache = new Map<string, CacheEntry>()

export function clearServiceIdentityCacheForTests(): void {
  identityCache.clear()
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function* ancestorDirectories(startDir: string): Generator<string> {
  let current = path.resolve(startDir)
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    yield current
    const parent = path.dirname(current)
    if (parent === current) {
      return
    }
    current = parent
  }
}

/**
 * Nearest ancestor holding `.git`, falling back to the nearest build manifest.
 *
 * The `.git`-first rule is deliberate: for `.../mono-numis-store/apps/market`
 * the useful project answer is `mono-numis-store`, not `market`. The app name
 * is reported separately as the service.
 */
export async function resolveProjectRoot(startDir: string): Promise<string | null> {
  let manifestRoot: string | null = null
  for (const dir of ancestorDirectories(startDir)) {
    if (await pathExists(path.join(dir, '.git'))) {
      return dir
    }
    if (!manifestRoot) {
      // Probe the manifests together: the walk can run to the filesystem root
      // because a .git may still appear above, and serialising five stat calls
      // per ancestor is the difference between one round of IO and dozens.
      const found = await Promise.all(
        ROOT_MANIFESTS.map((manifest) => pathExists(path.join(dir, manifest)))
      )
      if (found.some(Boolean)) {
        manifestRoot = dir
      }
    }
  }
  return manifestRoot
}

/**
 * `name` from the nearest ancestor `package.json`, bounded by the project root
 * so a lookup cannot escape into an unrelated parent project.
 */
export async function resolveServiceName(
  startDir: string,
  projectRoot: string | null
): Promise<string | null> {
  for (const dir of ancestorDirectories(startDir)) {
    const name = await readPackageName(path.join(dir, 'package.json'))
    if (name) {
      return name
    }
    if (projectRoot && path.resolve(dir) === path.resolve(projectRoot)) {
      break
    }
  }
  return null
}

async function readPackageName(manifestPath: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    const name = (parsed as { name?: unknown }).name
    if (typeof name !== 'string' || !name.trim()) {
      return null
    }
    // Scoped packages read better without the scope in a narrow column.
    const trimmed = name.trim()
    return trimmed.startsWith('@') && trimmed.includes('/')
      ? trimmed.slice(trimmed.indexOf('/') + 1)
      : trimmed
  } catch {
    return null
  }
}

/**
 * Resolve the project and service a working directory belongs to.
 *
 * Returns nulls rather than guesses: a wrong project name here is worse than
 * an em dash, because the whole point of the column is trusting the answer.
 */
export async function resolveServiceIdentity(cwd: string | undefined): Promise<ServiceIdentity> {
  if (!cwd || !cwd.trim() || cwd === '/') {
    return EMPTY_IDENTITY
  }

  const key = path.resolve(cwd)
  const now = Date.now()
  sweepExpiredIdentities(now)
  const cached = identityCache.get(key)
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value
  }

  const projectRoot = await resolveProjectRoot(key)
  const identity: ServiceIdentity = {
    projectRoot,
    projectName: projectRoot ? path.basename(projectRoot) : null,
    serviceName: await resolveServiceName(key, projectRoot)
  }
  rememberIdentity(key, identity, Date.now())
  return identity
}

function sweepExpiredIdentities(now: number): void {
  for (const [key, entry] of identityCache) {
    if (now - entry.at >= CACHE_TTL_MS) {
      identityCache.delete(key)
    }
  }
}

function rememberIdentity(key: string, value: ServiceIdentity, now: number): void {
  identityCache.set(key, { value, at: now })
  while (identityCache.size > CACHE_MAX_ENTRIES) {
    const oldest = identityCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    identityCache.delete(oldest)
  }
}
