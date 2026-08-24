import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { constants as fsConstants } from 'node:fs'
import { gitExecFileAsync } from '../git/runner'
import { runProcess } from '../../shared/child-process/run-process'
import { buildWslExecArgs, quotePosixShell } from '../../shared/wsl-login-shell-command'
import { parseWslPath } from '../wsl'
import {
  buildOriginHeadFetchArgs,
  buildOriginTrackingRefFetchArgs,
  buildOriginHeadUpdateRefArgs,
  buildRepoProjectSeedCloneArgs,
  buildSeedGitDirConfigArgs,
  getRepoManagedProjectsGitDir,
  parseRepoProjectList,
  resolveRepoManagedSourceGitDir
} from './repo-managed-checkout'

export const REPO_MANAGED_LOCAL_OBJECTS_MISSING =
  'Cannot derive from local objects: no project git directories were found under the main tree.'

const REPO_SEED_GIT_TIMEOUT_MS = 120_000

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

type WslSeedProject = {
  relPath: string
  sourceGitDir: string
  destGitDir: string
}

async function seedWslProjects(args: {
  projects: readonly WslSeedProject[]
  destPath: string
  distro: string
  onProjectComplete?: (relPath: string) => void
}): Promise<void> {
  const cwd = parseWslPath(args.destPath)?.linuxPath ?? args.destPath
  const q = quotePosixShell
  const script = ['set -e', `cd ${q(cwd)}`]
  for (const project of args.projects) {
    const source = parseWslPath(project.sourceGitDir)?.linuxPath ?? project.sourceGitDir
    const dest = parseWslPath(project.destGitDir)?.linuxPath ?? project.destGitDir
    const parent = dest.slice(0, dest.lastIndexOf('/')) || '/'
    script.push(
      `mkdir -p ${q(parent)}`,
      `if [ ! -d ${q(dest)} ]; then git clone --bare --no-local --reference ${q(source)} ${q(source)} ${q(dest)}; fi`,
      `git --git-dir=${q(dest)} config core.bare false`,
      `git --git-dir=${q(dest)} config remote.origin.url ${q(source)}`,
      `git --git-dir=${q(dest)} config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
      `git --git-dir=${q(dest)} fetch --no-tags ${q(source)} '+refs/heads/*:refs/remotes/origin/*' || true`,
      `git --git-dir=${q(dest)} fetch --no-tags ${q(source)} '+refs/remotes/origin/*:refs/remotes/origin/*' || true`,
      `printf 'ORCA_SEED_DONE:%s\\n' ${q(project.relPath)}`
    )
  }
  let stdoutBuffer = ''
  const result = await runProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(args.distro, ['/bin/bash', '-s', '--']),
    input: script.join('\n'),
    timeoutMs: REPO_SEED_GIT_TIMEOUT_MS * args.projects.length,
    onStdout: (chunk) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('ORCA_SEED_DONE:')) {
          args.onProjectComplete?.(line.slice('ORCA_SEED_DONE:'.length))
        }
      }
    }
  })
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'WSL repo seed failed')
  }
}

async function publishLocalHeadsAsOrigin(
  destGitDir: string,
  sourceGitDir: string,
  cwd: string
): Promise<void> {
  for (const args of buildSeedGitDirConfigArgs(destGitDir, sourceGitDir)) {
    await gitExecFileAsync(args, { cwd, timeout: REPO_SEED_GIT_TIMEOUT_MS })
  }
  try {
    await gitExecFileAsync(buildOriginHeadFetchArgs(destGitDir, sourceGitDir), {
      cwd,
      timeout: REPO_SEED_GIT_TIMEOUT_MS
    })
  } catch {}
  try {
    await gitExecFileAsync(buildOriginTrackingRefFetchArgs(destGitDir, sourceGitDir), {
      cwd,
      timeout: REPO_SEED_GIT_TIMEOUT_MS
    })
  } catch {}
  const { stdout } = await gitExecFileAsync(
    ['--git-dir', destGitDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { cwd, timeout: REPO_SEED_GIT_TIMEOUT_MS }
  )
  for (const branch of stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    try {
      await gitExecFileAsync(buildOriginHeadUpdateRefArgs(destGitDir, branch), {
        cwd,
        timeout: REPO_SEED_GIT_TIMEOUT_MS
      })
    } catch {}
  }
}

export type RepoManagedSeedProgress = {
  currentProject: string
  processedProjects: number
  totalProjects: number
}

export async function seedDerivedRepoProjectGitDirs(args: {
  mainPath: string
  destPath: string
  onProgress?: (progress: RepoManagedSeedProgress) => void
}): Promise<number> {
  const destRelPaths = await readProjectRelPaths(args.destPath)
  const relPaths = destRelPaths.length > 0 ? destRelPaths : await readProjectRelPaths(args.mainPath)
  const wsl = parseWslPath(args.destPath)
  const projects: WslSeedProject[] = []
  let seeded = 0

  for (const relPath of relPaths) {
    const sourceGitDir = await resolveSourceProjectGitDir(args.mainPath, relPath)
    if (!sourceGitDir) {
      args.onProgress?.({
        currentProject: relPath,
        processedProjects: seeded,
        totalProjects: relPaths.length
      })
      continue
    }
    projects.push({
      relPath,
      sourceGitDir,
      destGitDir: getRepoManagedProjectsGitDir(args.destPath, relPath)
    })
  }

  if (wsl) {
    await seedWslProjects({
      projects,
      destPath: args.destPath,
      distro: wsl.distro,
      onProjectComplete: (relPath) => {
        seeded += 1
        args.onProgress?.({
          currentProject: relPath,
          processedProjects: seeded,
          totalProjects: relPaths.length
        })
      }
    })
    seeded = projects.length
  } else {
    for (const project of projects) {
      if (!(await pathExists(project.destGitDir))) {
        await mkdir(dirname(project.destGitDir), { recursive: true })
        await gitExecFileAsync(
          buildRepoProjectSeedCloneArgs(project.sourceGitDir, project.destGitDir),
          { cwd: args.destPath, timeout: REPO_SEED_GIT_TIMEOUT_MS }
        )
      }
      await publishLocalHeadsAsOrigin(project.destGitDir, project.sourceGitDir, args.destPath)
      seeded += 1
      args.onProgress?.({
        currentProject: project.relPath,
        processedProjects: seeded,
        totalProjects: relPaths.length
      })
    }
  }

  if (relPaths.length > 0 && seeded === 0) {
    throw new Error(REPO_MANAGED_LOCAL_OBJECTS_MISSING)
  }
  return seeded
}
