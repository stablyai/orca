import { basename } from 'node:path'
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
  join: (parent: string, child: string) => string
  basename: (path: string) => string
  realpath?: (path: string) => Promise<string>
  exists: (path: string) => Promise<boolean>
}

const DEFAULT_MANIFEST_FILE = 'default.xml'

function trimGitOutput(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
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
      manifestFile = args.paths.basename(await args.paths.realpath(manifestXml)) || DEFAULT_MANIFEST_FILE
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
  return ['sync', '--local-only', '--current-branch', '--fail-fast']
}
