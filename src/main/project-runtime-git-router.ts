/**
 * The store-backed router behind local-git-runtime-route.ts: a folder inside a local project's
 * repo or one of its worktrees runs Git where that project's runtime does.
 *
 * Never stale in the dangerous direction (host Git on a WSL project's checkout): the table is
 * dropped on every store write that can change it, before the writer's next statement, and a
 * folder the table doesn't know is traced through its `.git` link to the repo it belongs to.
 */
import { win32 } from 'node:path'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { resolveProjectExecutionRuntime } from '../shared/project-execution-runtime'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Project } from '../shared/project-types'
import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/repo-types'
import { getRepoIdFromWorktreeId, splitWorktreeIdForFilesystem } from '../shared/worktree/id'
import {
  setBackgroundWslGitGate,
  setLocalGitRuntimeRouter,
  type LocalGitRuntimeRouter
} from './git/command-runner/local-git-runtime-route'
import { isWslDistroRunningForBackgroundWork } from './wsl-background-distro-gate'
import { wslHostsGateOpen } from './wsl/wsl-host-gate'
import {
  followWslAutomountRoots,
  knownWslAutomountRoots,
  onWslAutomountRootsChanged,
  wslDrivePathUnderRoots
} from './wsl/wsl-automount-root'

export type ProjectRuntimeGitRouterStore = {
  getRepos: () => Repo[]
  getProjects: () => Project[]
  getSettings: () => Partial<Pick<GlobalSettings, 'localWindowsRuntimeDefault'>>
  getAllWorktreeMeta: () => Record<string, unknown>
}

/** The `.git` entry at or above a folder: a main checkout's directory or a worktree's link file. */
export type DotGitReader = (folder: string) => { root: string; gitdir: string | null } | null

export type ProjectRuntimeGitRouterFs = {
  readDotGit: DotGitReader
  /** The real folder behind a symlink, junction or `subst` drive; null when it can't be read. */
  realpath: (folder: string) => string | null
  /** Each WSL project distro's drive mount root (`/mnt/` by default), for links WSL Git wrote. */
  automountRoots: () => readonly string[]
}

type Route = { root: string; wslDistro: string | undefined }

export type ProjectRuntimeGitRouter = LocalGitRuntimeRouter & {
  /** Drops the table and every traced folder; the next lookup rebuilds from the store. */
  invalidate: () => void
  /** The distros the projects' Git runs in. */
  distros: () => string[]
}

export function createProjectRuntimeGitRouter(
  store: ProjectRuntimeGitRouterStore,
  fs: ProjectRuntimeGitRouterFs = {
    readDotGit: readNearestDotGit,
    realpath: readRealpath,
    automountRoots: knownWslAutomountRoots
  }
): ProjectRuntimeGitRouter {
  let routes: Route[] | null = null
  // Bumped by each write, so a miss rebuilds the table at most once per write.
  let generation = 0
  let rebuiltForGeneration = -1
  // Each folder is traced once per write; the walk stats the disk, on the main thread.
  const traced = new Map<string, string | undefined>()
  const table = (): Route[] => (routes ??= buildRoutes(store))
  const lookup = (folder: string): Route | undefined =>
    table().find(
      ({ root }) => folder === root || folder.startsWith(root.endsWith('/') ? root : `${root}/`)
    )
  const trace = (cwd: string): string | undefined => {
    const found = fs.readDotGit(cwd)
    if (!found) {
      return undefined
    }
    if (found.gitdir !== null) {
      // A worktree created a moment ago has no metadata yet: follow its link to its repo.
      const repos = linkedRepoPaths(found.root, found.gitdir, fs.automountRoots())
      return repos
        .map((repo) => lookup(normalizeRuntimePathForComparison(repo)))
        .find((route) => route !== undefined)?.wslDistro
    }
    const target = found.root
    const known = lookup(normalizeRuntimePathForComparison(target))
    if (known) {
      return known.wslDistro
    }
    // A symlink, junction or `subst` drive can name a WSL project's checkout under another path.
    const real = fs.realpath(target)
    return real ? lookup(normalizeRuntimePathForComparison(real))?.wslDistro : undefined
  }
  const route = (cwd: string): string | undefined => {
    const folder = normalizeRuntimePathForComparison(cwd)
    let known = lookup(folder)
    if (!known && rebuiltForGeneration !== generation) {
      // A miss rebuilds once, in case a write reached the store without a change event.
      rebuiltForGeneration = generation
      routes = null
      known = lookup(folder)
    }
    if (known) {
      return known.wslDistro
    }
    if (!traced.has(folder)) {
      traced.set(folder, trace(cwd))
    }
    return traced.get(folder)
  }
  const invalidate = (): void => {
    routes = null
    traced.clear()
    generation += 1
  }
  return Object.assign(route, {
    invalidate,
    distros: () => [...new Set(table().flatMap(({ wslDistro }) => (wslDistro ? [wslDistro] : [])))]
  })
}

/**
 * The main checkouts a linked worktree's `gitdir` may point into, most likely first. Windows Git
 * writes a drive path; WSL Git writes the distro's view, `<automount root><drive>/…`, and the
 * root differs per distro, so each known root is a candidate the caller checks against its
 * projects. A link into the distro itself (`/home/…`, `//wsl.localhost/…`) names no drive folder.
 */
function linkedRepoPaths(
  root: string,
  gitdir: string,
  automountRoots: readonly string[]
): string[] {
  const windowsForms = /^[\\/]/.test(gitdir)
    ? automountRoots.flatMap((mount) => wslDrivePathUnderRoots(gitdir, [mount]) ?? [])
    : [win32.resolve(root, gitdir)]
  return windowsForms.flatMap((form) => {
    const match = /^(.*)[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(form)
    const commonDir = match ? win32.resolve(match[1]) : null
    return commonDir && win32.basename(commonDir).toLowerCase() === '.git'
      ? [win32.dirname(commonDir)]
      : []
  })
}

// Deep enough for any checkout, bounded so a cwd on a dead mapped drive stats only so far.
const MAX_WALK_DEPTH = 16

/** Windows paths only: the router routes drive-path folders. */
function readNearestDotGit(folder: string): { root: string; gitdir: string | null } | null {
  let current = folder
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const entry = win32.join(current, '.git')
    try {
      if (statSync(entry).isDirectory()) {
        return { root: current, gitdir: null }
      }
      const link = /^gitdir:\s*(.+)$/m.exec(readFileSync(entry, 'utf8'))
      return { root: current, gitdir: link ? link[1].trim() : null }
    } catch {
      // No `.git` here; keep walking up.
    }
    const parent = win32.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
  return null
}

function readRealpath(folder: string): string | null {
  try {
    return realpathSync.native(folder)
  } catch {
    return null
  }
}

function buildRoutes(store: ProjectRuntimeGitRouterStore): Route[] {
  const projects = store.getProjects()
  const globalDefault = store.getSettings().localWindowsRuntimeDefault
  const localRepos = new Map(
    store
      .getRepos()
      .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
      .map((repo) => [repo.id, repo])
  )
  const distroByRepo = new Map(
    [...localRepos.values()].map((repo) => [repo.id, wslGitDistro(repo, projects, globalDefault)])
  )
  // Host-Git routes stay too, so a project nested in a WSL one keeps its own Git.
  const routes: Route[] = [...localRepos.values()].map((repo) => ({
    root: normalizeRuntimePathForComparison(repo.path),
    wslDistro: distroByRepo.get(repo.id)
  }))
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const parsed = localRepos.has(repoId) ? splitWorktreeIdForFilesystem(worktreeId) : null
    if (parsed) {
      routes.push({
        root: normalizeRuntimePathForComparison(parsed.worktreePath),
        wslDistro: distroByRepo.get(repoId)
      })
    }
  }
  // Longest first, so a worktree nested in another project's folder takes its own runtime.
  return routes.sort((left, right) => right.root.length - left.root.length)
}

/**
 * From the saved preference alone, not WSL's discovery caches: a missing distro makes the call
 * fail in WSL, which is safe, where falling back to host Git on a WSL checkout is not.
 */
function wslGitDistro(
  repo: Repo,
  projects: readonly Project[],
  globalWindowsRuntimeDefault: unknown
): string | undefined {
  if (isFolderRepo(repo)) {
    return undefined
  }
  const project = projects.find((entry) => entry.sourceRepoIds.includes(repo.id))
  const resolution = resolveProjectExecutionRuntime({
    appPlatform: 'win32',
    projectId: project?.id ?? repo.id,
    projectRuntimePreference: project?.localWindowsRuntimePreference,
    globalWindowsRuntimeDefault
  })
  return resolution.status === 'resolved' &&
    resolution.runtime.kind === 'wsl' &&
    resolution.runtime.git !== 'windows-host'
    ? resolution.runtime.distro
    : undefined
}

const ROUTE_DOMAINS: ReadonlySet<string> = new Set([
  'repos',
  'projects',
  'settings',
  'worktreeMeta',
  'worktreeMetaByIdentity',
  'worktreeIdentityAliases'
])

/**
 * Ships with WSL hosts (D1c): until then a WSL-runtime `C:\` project keeps today's mix, because
 * routing all of its Git through WSL is ~300x slower there before it can switch to Git for Windows.
 */
export function installProjectRuntimeGitRouter(
  store: ProjectRuntimeGitRouterStore & {
    onStateWritten: (listener: (dirtyDomains: readonly string[] | undefined) => void) => () => void
  }
): void {
  if (process.platform !== 'win32' || !wslHostsGateOpen()) {
    setLocalGitRuntimeRouter(null)
    setBackgroundWslGitGate(null)
    return
  }
  setBackgroundWslGitGate(isWslDistroRunningForBackgroundWork)
  const router = createProjectRuntimeGitRouter(store)
  // Synchronous with the write, so no Git call can run between a change and the table's drop.
  store.onStateWritten((domains) => {
    if (!domains || domains.some((domain) => ROUTE_DOMAINS.has(domain))) {
      router.invalidate()
    }
  })
  // A distro's mount root changes how links its Git wrote map back to a drive.
  followWslAutomountRoots(router.distros)
  onWslAutomountRootsChanged(router.invalidate)
  setLocalGitRuntimeRouter(router)
}
