import { existsSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { normalizeRuntimePathSeparators } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { scanGitMarkerSync, resolveRealPathSync } from './repo-git-marker-scan'
import { gitExecFileSync } from './runner'

type GitRepoProbeResult = 'repo' | 'not-repo' | 'indeterminate'

let warnedMarkerFallbackThisSession = false

/** Check if a path is a valid git repository (regular or bare). */
export function isGitRepo(path: string): boolean {
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      return false
    }
  } catch {
    return false
  }

  const gitProbeResult = probeGitRepo(path)
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

/** Only a clean pair of negative Git answers is a definitive non-repo. */
function probeGitRepo(path: string): GitRepoProbeResult {
  let sawFailure = false

  try {
    const insideWorkTree = gitExecFileSync(['rev-parse', '--is-inside-work-tree'], {
      cwd: path
    }).trim()
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
    const bareRepo = gitExecFileSync(['rev-parse', '--is-bare-repository'], {
      cwd: path
    }).trim()
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

export function getGitRepoRoot(path: string): string {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return path
    }
    // One spawn, not two: each sync git call blocks main for up to its whole 15s
    // timeout, so the spawn count is the cost. Safe to combine only here — a bare
    // repo makes the combined form exit non-zero, and both that throw and the
    // plain `false` land on the same marker-scan fallback below. `probeGitRepo`
    // must NOT combine: it has to read `false` cleanly to go on and detect bare.
    const [insideWorkTree, toplevel] = gitExecFileSync(
      ['rev-parse', '--is-inside-work-tree', '--show-toplevel'],
      { cwd: path }
    )
      .split('\n')
      .map((line) => line.trim())
    if (insideWorkTree === 'true' && toplevel) {
      return normalizeGitRepoRootForInputPath(path, toplevel)
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
export function getLinkedWorktreeMainRepoRoot(path: string): string | null {
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      return null
    }
    if (gitExecFileSync(['rev-parse', '--is-inside-work-tree'], { cwd: path }).trim() !== 'true') {
      return null
    }
    const [gitDir, commonDir] = gitExecFileSync(['rev-parse', '--git-dir', '--git-common-dir'], {
      cwd: path
    })
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
    return getGitRepoRoot(dirname(absoluteCommonDir))
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
