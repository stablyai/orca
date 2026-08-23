import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { constants as fsConstants } from 'node:fs'
import { gitExecFileAsync } from '../git/runner'
import {
  buildOriginHeadFetchArgs,
  buildOriginHeadUpdateRefArgs,
  buildRepoProjectSeedCloneArgs,
  buildSeedGitDirConfigArgs,
  getRepoManagedProjectsGitDir,
  parseRepoProjectList,
  resolveRepoManagedSourceGitDir
} from './repo-managed-checkout'

export const REPO_MANAGED_LOCAL_OBJECTS_MISSING =
  'Cannot derive from local objects: no project git directories were found under the main tree.'

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readProjectRelPaths(rootPath: string): Promise<string[]> {
  try {
    const content = await readFile(join(rootPath, '.repo', 'project.list'), 'utf8')
    return parseRepoProjectList(content)
  } catch {
    return []
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function resolveSourceProjectGitDir(
  mainPath: string,
  relPath: string
): Promise<string | null> {
  return resolveRepoManagedSourceGitDir({
    mainPath,
    relPath,
    paths: {
      join,
      isDirectory,
      isFile,
      readTextFile: (path) => readFile(path, 'utf8')
    }
  })
}

async function publishLocalHeadsAsOrigin(
  destGitDir: string,
  sourceGitDir: string,
  cwd: string
): Promise<void> {
  for (const args of buildSeedGitDirConfigArgs(destGitDir, sourceGitDir)) {
    await gitExecFileAsync(args, { cwd })
  }
  try {
    await gitExecFileAsync(buildOriginHeadFetchArgs(destGitDir, sourceGitDir), { cwd })
  } catch {
    // The source may only have local heads. Publishing those as origin refs below is enough.
  }
  const { stdout } = await gitExecFileAsync(
    ['--git-dir', destGitDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { cwd }
  )
  for (const branch of stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    await gitExecFileAsync(buildOriginHeadUpdateRefArgs(destGitDir, branch), { cwd })
  }
}

export async function seedDerivedRepoProjectGitDirs(args: {
  mainPath: string
  destPath: string
}): Promise<number> {
  const destRelPaths = await readProjectRelPaths(args.destPath)
  const relPaths = destRelPaths.length > 0 ? destRelPaths : await readProjectRelPaths(args.mainPath)
  let seeded = 0
  for (const relPath of relPaths) {
    const sourceGitDir = await resolveSourceProjectGitDir(args.mainPath, relPath)
    if (!sourceGitDir) {
      continue
    }
    const destGitDir = getRepoManagedProjectsGitDir(args.destPath, relPath)
    if (!(await pathExists(destGitDir))) {
      await mkdir(dirname(destGitDir), { recursive: true })
      await gitExecFileAsync(buildRepoProjectSeedCloneArgs(sourceGitDir, destGitDir), {
        cwd: args.destPath
      })
    }
    await publishLocalHeadsAsOrigin(destGitDir, sourceGitDir, args.destPath)
    seeded += 1
  }
  if (relPaths.length > 0 && seeded === 0) {
    throw new Error(REPO_MANAGED_LOCAL_OBJECTS_MISSING)
  }
  return seeded
}
