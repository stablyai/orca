import { existsSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { normalizeRuntimePathSeparators } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { scanGitMarkerSync, resolveRealPathSync } from './repo-git-marker-scan'
import {
  gitRepoOutput,
  runGitRepoCommands,
  runGitRepoCommandsSync,
  type GitRepoCommands
} from './repo-detection-command'

type GitRepoProbeResult = 'repo' | 'not-repo' | 'indeterminate'
type GitRepoProbe = {
  result: GitRepoProbeResult
  insideWorkTree?: boolean
  gitDir?: string
  commonDir?: string
}

export type GitRepoRegistrationInfo = {
  isRepo: boolean
  rootPath: string
  mainRepoPath: string | null
}

let warnedMarkerFallbackThisSession = false

/** Check if a path is a valid git repository (regular or bare). */
function* isGitRepoCommands(path: string): GitRepoCommands<boolean> {
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      return false
    }
  } catch {
    return false
  }

  return isGitRepoFromProbe(path, (yield* probeGitRepo(path)).result)
}

function isGitRepoFromProbe(path: string, result: GitRepoProbeResult): boolean {
  if (result === 'repo') {
    return true
  }
  if (result === 'not-repo') {
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
function* probeGitRepo(path: string, includeLocation = false): GitRepoCommands<GitRepoProbe> {
  try {
    const records = readGitPathOutput(
      yield* gitRepoOutput(
        [
          'rev-parse',
          '--is-inside-work-tree',
          '--is-bare-repository',
          ...(includeLocation ? ['--git-dir', '--git-common-dir'] : [])
        ],
        { cwd: path }
      )
    ).split('\n')
    const [insideWorkTree, bareRepo, gitDir, commonDir] = records
    const result =
      insideWorkTree === 'true' || bareRepo === 'true'
        ? 'repo'
        : insideWorkTree === 'false' && bareRepo === 'false'
          ? 'not-repo'
          : 'indeterminate'
    const location =
      includeLocation && insideWorkTree === 'true' && records.length !== 4
        ? yield* readGitRepoDirectories(path)
        : { gitDir, commonDir }
    return { result, insideWorkTree: insideWorkTree === 'true', ...location }
  } catch {
    return { result: 'indeterminate' }
  }
}

/** Reuse one repository discovery across registration's validity, root and worktree checks. */
function* inspectGitRepoForRegistrationCommands(
  path: string
): GitRepoCommands<GitRepoRegistrationInfo> {
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      return { isRepo: false, rootPath: path, mainRepoPath: null }
    }
  } catch {
    return { isRepo: false, rootPath: path, mainRepoPath: null }
  }
  const probe = yield* probeGitRepo(path)
  const isRepo = isGitRepoFromProbe(path, probe.result)
  let rootPath = path
  let mainRepoPath: string | null = null
  if (isRepo && probe.insideWorkTree) {
    try {
      const records = readGitPathOutput(
        yield* gitRepoOutput(
          [
            'rev-parse',
            '--is-inside-work-tree',
            '--show-toplevel',
            '--git-dir',
            '--git-common-dir'
          ],
          { cwd: path }
        )
      ).split('\n')
      const [insideWorkTree, toplevel, gitDir, commonDir] = records
      if (insideWorkTree === 'true') {
        // Newlines in paths make the combined records ambiguous.
        const location =
          records.length === 4 && toplevel && gitDir && commonDir
            ? { toplevel, gitDir, commonDir }
            : {
                toplevel: readGitPathOutput(
                  yield* gitRepoOutput(['rev-parse', '--show-toplevel'], { cwd: path })
                ),
                ...(yield* readGitRepoDirectories(path))
              }
        if (location.toplevel) {
          rootPath = normalizeGitRepoRootForInputPath(path, location.toplevel)
          mainRepoPath = mainRepoPathFromProbe(path, {
            result: 'repo',
            insideWorkTree: true,
            ...location
          })
        } else {
          rootPath = rootPathFromMarker(path)
        }
      } else {
        rootPath = rootPathFromMarker(path)
      }
    } catch {
      rootPath = rootPathFromMarker(path)
    }
  } else if (isRepo) {
    rootPath = rootPathFromMarker(path)
  }
  return { isRepo, rootPath, mainRepoPath }
}

function* getGitRepoRootCommands(path: string): GitRepoCommands<string> {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return path
    }
    // A bare repo has no toplevel; keep its marker fallback separate from the boolean probes.
    const output = yield* gitRepoOutput(['rev-parse', '--is-inside-work-tree', '--show-toplevel'], {
      cwd: path
    })
    const firstNewline = output.indexOf('\n')
    if (firstNewline !== -1 && output.slice(0, firstNewline).trim() === 'true') {
      const toplevel = readGitPathOutput(output.slice(firstNewline + 1))
      if (toplevel) {
        return normalizeGitRepoRootForInputPath(path, toplevel)
      }
    }
  } catch {
    // Fall through to preserving the original path.
  }
  return rootPathFromMarker(path)
}

function readGitPathOutput(output: string): string {
  return output.endsWith('\n') ? output.slice(0, -1) : output
}

function* readGitRepoDirectories(
  path: string
): GitRepoCommands<Pick<GitRepoProbe, 'gitDir' | 'commonDir'>> {
  return {
    gitDir: readGitPathOutput(yield* gitRepoOutput(['rev-parse', '--git-dir'], { cwd: path })),
    commonDir: readGitPathOutput(
      yield* gitRepoOutput(['rev-parse', '--git-common-dir'], { cwd: path })
    )
  }
}

function rootPathFromMarker(path: string): string {
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
function* getLinkedWorktreeMainRepoRootCommands(path: string): GitRepoCommands<string | null> {
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      return null
    }
    const mainRepoPath = mainRepoPathFromProbe(path, yield* probeGitRepo(path, true))
    return mainRepoPath ? yield* getGitRepoRootCommands(mainRepoPath) : null
  } catch {
    return null
  }
}

function mainRepoPathFromProbe(path: string, probe: GitRepoProbe): string | null {
  if (!probe.insideWorkTree || !probe.gitDir || !probe.commonDir) {
    return null
  }
  const absoluteCommonDir = canonicalizeGitDirPath(resolve(path, probe.commonDir))
  if (
    canonicalizeGitDirPath(resolve(path, probe.gitDir)) === absoluteCommonDir ||
    basename(absoluteCommonDir) !== '.git'
  ) {
    return null
  }
  return dirname(absoluteCommonDir)
}

export function normalizeGitRepoRootForInputPath(inputPath: string, rootPath: string): string {
  const inputWsl = parseWslUncPath(inputPath)
  if (inputWsl && rootPath.startsWith('/')) {
    // Why: persist the UNC root so later Git calls keep routing through the WSL runner.
    return toWindowsWslPath(rootPath, inputWsl.distro)
  }
  return normalizeRuntimePathSeparators(rootPath)
}

export function isGitRepo(path: string): boolean {
  return runGitRepoCommandsSync(isGitRepoCommands(path))
}

export function isGitRepoAsync(path: string): Promise<boolean> {
  return runGitRepoCommands(isGitRepoCommands(path))
}

export function inspectGitRepoForRegistration(path: string): GitRepoRegistrationInfo {
  return runGitRepoCommandsSync(inspectGitRepoForRegistrationCommands(path))
}

export function inspectGitRepoForRegistrationAsync(path: string): Promise<GitRepoRegistrationInfo> {
  return runGitRepoCommands(inspectGitRepoForRegistrationCommands(path))
}

export function getGitRepoRoot(path: string): string {
  return runGitRepoCommandsSync(getGitRepoRootCommands(path))
}

export function getGitRepoRootAsync(path: string): Promise<string> {
  return runGitRepoCommands(getGitRepoRootCommands(path))
}

export function getLinkedWorktreeMainRepoRoot(path: string): string | null {
  return runGitRepoCommandsSync(getLinkedWorktreeMainRepoRootCommands(path))
}
