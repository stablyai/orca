import { join as joinPath } from 'node:path'
import { REPO_METADATA_DIR } from '../../shared/repo-managed-project'

export type RepoManagedCheckoutIdentity = {
  manifestUrl: string
  manifestBranch: string | null
  manifestFile: string
  groups: string | null
  repoUrl: string | null
}

export type RepoManagedGitReader = {
  configGet: (gitDir: string, key: string) => Promise<string | null>
  abbrevRef: (gitDir: string) => Promise<string | null>
}

export type RepoManagedPathReader = {
  join: (...parts: string[]) => string
  basename: (path: string) => string
  realpath?: (path: string) => Promise<string>
  exists: (path: string) => Promise<boolean>
}

const DEFAULT_MANIFEST_FILE = 'default.xml'

function trimGitOutput(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

/**
 * `.repo/manifest.xml` is usually a symlink into `.repo/manifests/<file>`.
 * `repo init -m` looks for that name inside the cloned manifests checkout,
 * so a regular file named `manifest.xml` must still init as `default.xml`.
 */
export function resolveRepoManagedManifestFile(
  resolvedPathBasename: string | null | undefined
): string {
  const name = resolvedPathBasename?.trim() || DEFAULT_MANIFEST_FILE
  return name === 'manifest.xml' ? DEFAULT_MANIFEST_FILE : name
}

export function getRepoManagedManifestsGitDir(
  mainPath: string,
  join: RepoManagedPathReader['join'] = joinPath
): string {
  return join(mainPath, REPO_METADATA_DIR, 'manifests.git')
}

export function getRepoManagedRepoToolPath(
  mainPath: string,
  join: RepoManagedPathReader['join'] = joinPath
): string {
  return join(mainPath, REPO_METADATA_DIR, 'repo', 'repo')
}

export async function readRepoManagedCheckoutIdentity(args: {
  mainPath: string
  git: RepoManagedGitReader
  paths: RepoManagedPathReader
}): Promise<RepoManagedCheckoutIdentity> {
  const manifestsGitDir = getRepoManagedManifestsGitDir(args.mainPath, args.paths.join)
  const originUrl = trimGitOutput(await args.git.configGet(manifestsGitDir, 'remote.origin.url'))
  const groups = trimGitOutput(await args.git.configGet(manifestsGitDir, 'manifest.groups'))
  const abbrev = trimGitOutput(await args.git.abbrevRef(manifestsGitDir))
  const manifestBranch = abbrev && abbrev !== 'HEAD' ? abbrev : null
  const manifestXml = args.paths.join(args.mainPath, REPO_METADATA_DIR, 'manifest.xml')
  let manifestFile = DEFAULT_MANIFEST_FILE
  if (args.paths.realpath) {
    try {
      manifestFile = resolveRepoManagedManifestFile(
        args.paths.basename(await args.paths.realpath(manifestXml))
      )
    } catch {
      manifestFile = DEFAULT_MANIFEST_FILE
    }
  }
  const bundledRepo = getRepoManagedRepoToolPath(args.mainPath, args.paths.join)
  const repoUrl = (await args.paths.exists(bundledRepo))
    ? args.paths.join(args.mainPath, REPO_METADATA_DIR, 'repo')
    : null
  return {
    manifestUrl: originUrl ?? manifestsGitDir,
    manifestBranch,
    manifestFile,
    groups,
    repoUrl
  }
}

export function buildRepoInitArgs(args: {
  identity: RepoManagedCheckoutIdentity
  referencePath: string
}): string[] {
  const initArgs = ['init', '-u', args.identity.manifestUrl, '-m', args.identity.manifestFile]
  if (args.identity.manifestBranch) {
    initArgs.push('-b', args.identity.manifestBranch)
  }
  initArgs.push('--reference', args.referencePath)
  if (args.identity.groups) {
    initArgs.push('--groups', args.identity.groups)
  }
  if (args.identity.repoUrl) {
    initArgs.push('--repo-url', args.identity.repoUrl)
  }
  return initArgs
}

export function buildRepoSyncArgs(): string[] {
  return ['sync', '--local-only', '--no-manifest-update', '--fail-fast']
}

export function getRepoManagedProjectsGitDir(
  rootPath: string,
  relPath: string,
  join: RepoManagedPathReader['join'] = joinPath
): string {
  return join(rootPath, REPO_METADATA_DIR, 'projects', `${relPath}.git`)
}

export function parseRepoProjectList(content: string): string[] {
  const paths: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    paths.push(trimmed)
  }
  return paths
}

export function parseGitDirPointer(
  content: string,
  worktreePath: string,
  join: RepoManagedPathReader['join'] = joinPath
): string | null {
  const match = /^gitdir:\s*(.+)$/m.exec(content)
  const pointer = match?.[1]?.trim()
  if (!pointer) {
    return null
  }
  return pointer.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pointer)
    ? pointer
    : join(worktreePath, pointer)
}

export type RepoManagedSourceGitProbe = {
  join: RepoManagedPathReader['join']
  isDirectory: (path: string) => boolean | Promise<boolean>
  isFile: (path: string) => boolean | Promise<boolean>
  readTextFile: (path: string) => Promise<string>
}

export async function resolveRepoManagedSourceGitDir(args: {
  mainPath: string
  relPath: string
  paths: RepoManagedSourceGitProbe
}): Promise<string | null> {
  const join = args.paths.join
  const farm = getRepoManagedProjectsGitDir(args.mainPath, args.relPath, join)
  if (await args.paths.isDirectory(farm)) {
    return farm
  }
  const worktree = join(args.mainPath, args.relPath)
  const gitPath = join(worktree, '.git')
  if (await args.paths.isDirectory(gitPath)) {
    return gitPath
  }
  if (!(await args.paths.isFile(gitPath))) {
    return null
  }
  let pointer: string | null = null
  try {
    pointer = parseGitDirPointer(await args.paths.readTextFile(gitPath), worktree, join)
  } catch {
    return null
  }
  if (!pointer || !(await args.paths.isDirectory(pointer))) {
    return null
  }
  return pointer
}

export function buildRepoProjectSeedCloneArgs(sourceGitDir: string, destGitDir: string): string[] {
  return ['clone', '--bare', '--reference', sourceGitDir, sourceGitDir, destGitDir]
}

export function buildOriginHeadFetchArgs(destGitDir: string, sourceGitDir: string): string[] {
  return [
    '--git-dir',
    destGitDir,
    'fetch',
    '--no-tags',
    sourceGitDir,
    '+refs/heads/*:refs/remotes/origin/*'
  ]
}

export function buildOriginHeadUpdateRefArgs(destGitDir: string, branch: string): string[] {
  return [
    '--git-dir',
    destGitDir,
    'update-ref',
    `refs/remotes/origin/${branch}`,
    `refs/heads/${branch}`
  ]
}

/**
 * `git clone --bare` leaves `core.bare=true` and no fetch refspec.
 * Google repo attaches a worktree via `.git` symlink/gitfile and maps
 * `revision=main` through `remote.origin.fetch` in `ToLocal()`.
 */
export function buildSeedGitDirConfigArgs(destGitDir: string, sourceGitDir: string): string[][] {
  return [
    ['--git-dir', destGitDir, 'config', 'core.bare', 'false'],
    ['--git-dir', destGitDir, 'config', 'remote.origin.url', sourceGitDir],
    [
      '--git-dir',
      destGitDir,
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*'
    ]
  ]
}
