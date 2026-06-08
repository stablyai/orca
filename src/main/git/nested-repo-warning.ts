import type { NestedRepoWarning } from '../../shared/types'
import {
  createLocalNestedRepoScanFilesystem,
  scanNestedRepos
} from '../project-groups/nested-repo-discovery'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import { gitExecFileAsync } from './runner'

export const NESTED_REPO_DISPLAY_CAP = 10

export type NestedRepoDetectionDeps = {
  /** Test seam: replaces the nested-repo scanner. */
  scan?: typeof scanNestedRepos
}

// Why: pure string relativization instead of path.relative — candidates may carry
// either separator (Windows scans) and path.relative on POSIX does not treat '\'
// as a separator, which would break both the git pathspecs and the display.
function toSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

function relativizeToToplevel(toplevel: string, candidatePath: string): string | null {
  const root = toSlashes(toplevel).replace(/\/+$/, '')
  const candidate = toSlashes(candidatePath)
  if (!candidate.startsWith(`${root}/`)) {
    return null
  }
  const relative = candidate.slice(root.length + 1).replace(/\/+$/, '')
  return relative.length > 0 ? relative : null
}

function parseGitlinkPaths(lsFilesZOutput: string): Set<string> {
  const gitlinks = new Set<string>()
  for (const record of lsFilesZOutput.split('\0')) {
    if (!record) {
      continue
    }
    const tabIndex = record.indexOf('\t')
    if (tabIndex === -1) {
      continue
    }
    const [mode] = record.slice(0, tabIndex).split(' ')
    if (mode === '160000') {
      gitlinks.add(record.slice(tabIndex + 1))
    }
  }
  return gitlinks
}

function parseGitmodulesPaths(configOutput: string): Set<string> {
  const declared = new Set<string>()
  for (const line of configOutput.split(/\r?\n/)) {
    const spaceIndex = line.indexOf(' ')
    if (spaceIndex === -1) {
      continue
    }
    const value = toSlashes(line.slice(spaceIndex + 1).trim()).replace(/\/+$/, '')
    if (value) {
      declared.add(value)
    }
  }
  return declared
}

/**
 * Detect independent nested git repos inside `repoPath` that a worktree of the
 * parent repo would NOT materialize. Tracked submodules (staged gitlinks or
 * `.gitmodules` declarations) are intentional layouts and never warn.
 *
 * Never throws and never rejects; resolves null when there is nothing to warn
 * about (including any scan/git failure or timeout — a warning is best-effort).
 */
export async function detectUntrackedNestedRepos(
  repoPath: string,
  deps: NestedRepoDetectionDeps = {}
): Promise<NestedRepoWarning | null> {
  try {
    const { stdout } = await gitExecFileAsync(['rev-parse', '--show-toplevel'], { cwd: repoPath })
    const gitToplevel = stdout.trim()
    let toplevel = gitToplevel
    // Why: the WSL-aware runner returns Linux paths from git stdout; the fs scan
    // below runs in the Windows process and needs the UNC form.
    const wslInfo = parseWslPath(repoPath)
    if (wslInfo) {
      toplevel = toWindowsWslPath(gitToplevel, wslInfo.distro)
    }
    // Why: pathspecs and .gitmodules are toplevel-relative, so git commands must
    // run from the toplevel — except on WSL, where the git toplevel is a Linux
    // path the Windows process cannot use as cwd (the registered UNC repoPath
    // routes through the WSL-aware runner instead).
    const gitCwd = wslInfo ? repoPath : gitToplevel

    const scan = deps.scan ?? scanNestedRepos
    const result = await scan({
      path: toplevel,
      options: { maxDepth: 3, maxRepos: 100, timeoutMs: 5000 },
      filesystem: {
        ...createLocalNestedRepoScanFilesystem(),
        // Why: the scanner early-returns on git repos (it was built for non-git
        // project folders) and prunes gitignored dirs — but gitignored nested
        // repos are exactly the meta-repo case this warning exists for.
        isSelectedPathGitRepo: () => false,
        readTextFile: async () => ''
      }
    })
    if (result.timedOut) {
      return null
    }

    const candidates = result.repos
      .map((repo) => relativizeToToplevel(toplevel, repo.path))
      .filter((relative): relative is string => relative !== null)
      .sort()
    if (candidates.length === 0) {
      return null
    }

    const { stdout: lsFilesOut } = await gitExecFileAsync(
      ['ls-files', '-z', '--stage', '--', ...candidates],
      { cwd: gitCwd }
    )
    const gitlinks = parseGitlinkPaths(lsFilesOut)

    let declaredSubmodules = new Set<string>()
    try {
      const { stdout: configOut } = await gitExecFileAsync(
        ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
        { cwd: gitCwd }
      )
      declaredSubmodules = parseGitmodulesPaths(configOut)
    } catch {
      // Why: git config exits non-zero when .gitmodules is absent — not an error.
    }

    const untracked = candidates.filter(
      (candidate) => !gitlinks.has(candidate) && !declaredSubmodules.has(candidate)
    )
    if (untracked.length === 0) {
      return null
    }

    const shown = untracked.slice(0, NESTED_REPO_DISPLAY_CAP)
    return {
      paths: shown.map((candidate) => `${candidate}/`),
      truncated: untracked.length > shown.length,
      moreCount: untracked.length - shown.length
    }
  } catch {
    return null
  }
}
