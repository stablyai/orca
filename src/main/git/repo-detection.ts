import { existsSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { normalizeRuntimePathSeparators } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { scanGitMarkerSync, resolveRealPathSync } from './repo-git-marker-scan'
import { gitExecFileAsync } from './runner'

type GitRepoProbeResult = 'repo' | 'not-repo' | 'indeterminate'

let warnedMarkerFallbackThisSession = false

/** Check if a path is a valid git repository (regular or bare). */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      return false
    }
  } catch {
    return false
  }

  const gitProbeResult = await probeGitRepo(path)
  if (gitProbeResult === 'repo') {
    return true
  }
  if (gitProbeResult === 'not-repo') {
    return false
  }

  const markerScan = scanGitMarkerSync(path)
  if (markerScan.status === 'valid' && !warnedMarkerFallbackThisSession) {
    warnedMarkerFallbackThisSession = true
    console.warn('[isGitRepo] git rev-parse could not confirm repo; accepted via .git marker', {
      path
    })
  }
  return markerScan.status === 'valid'
}

function revParse(path: string, args: string[]): Promise<string> {
  return gitExecFileAsync(['rev-parse', ...args], { cwd: path }).then(({ stdout }) => stdout.trim())
}

/** Only a clean pair of negative Git answers is a definitive non-repo. */
async function probeGitRepo(path: string): Promise<GitRepoProbeResult> {
  let sawFailure = false

  try {
    const insideWorkTree = await revParse(path, ['--is-inside-work-tree'])
    if (insideWorkTree === 'true') {
      return 'repo'
    }
    if (insideWorkTree !== 'false') {
      return 'indeterminate'
    }
  } catch {
    sawFailure = true
  }

  try {
    const bareRepo = await revParse(path, ['--is-bare-repository'])
    if (bareRepo === 'true') {
      return 'repo'
    }
    if (bareRepo !== 'false') {
      return 'indeterminate'
    }
  } catch {
    sawFailure = true
  }

  return sawFailure ? 'indeterminate' : 'not-repo'
}

export async function getGitRepoRoot(path: string): Promise<string> {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return path
    }
    if ((await revParse(path, ['--is-inside-work-tree'])) === 'true') {
      return normalizeGitRepoRootForInputPath(path, await revParse(path, ['--show-toplevel']))
    }
  } catch {
    // Fall through to preserving the original path.
  }
  const markerScan = scanGitMarkerSync(path)
  if (markerScan.status === 'valid') {
    return normalizeGitRepoRootForInputPath(path, markerScan.rootPath)
  }
  return path
}

function canonicalizeGitDirPath(path: string): string {
  return resolveRealPathSync(path) ?? path
}

/** Return the main-checkout path only when `path` is a linked worktree. */
export async function getLinkedWorktreeMainRepoRoot(path: string): Promise<string | null> {
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      return null
    }
    if ((await revParse(path, ['--is-inside-work-tree'])) !== 'true') {
      return null
    }
    const [gitDir, commonDir] = (await revParse(path, ['--git-dir', '--git-common-dir']))
      .split('\n')
      .map((line) => line.trim())
    if (!gitDir || !commonDir) {
      return null
    }
    const absoluteCommonDir = canonicalizeGitDirPath(resolve(path, commonDir))
    if (canonicalizeGitDirPath(resolve(path, gitDir)) === absoluteCommonDir) {
      return null
    }
    if (basename(absoluteCommonDir) !== '.git') {
      return null
    }
    return await getGitRepoRoot(dirname(absoluteCommonDir))
  } catch {
    return null
  }
}

export function normalizeGitRepoRootForInputPath(inputPath: string, rootPath: string): string {
  const inputWsl = parseWslUncPath(inputPath)
  if (inputWsl && rootPath.startsWith('/')) {
    // Why: persist the UNC root so later Git calls keep routing through the WSL runner.
    return toWindowsWslPath(rootPath, inputWsl.distro)
  }
  return normalizeRuntimePathSeparators(rootPath)
}
