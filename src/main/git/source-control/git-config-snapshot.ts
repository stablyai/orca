import { homedir } from 'node:os'
import * as path from 'node:path'
import { BoundedMap } from '../../../shared/bounded-map'
import { resolveWorktreeHostPath } from '../../../shared/git/metadata/git-metadata-path'
import { wslDistroForCommand } from '../command-runner/git-command-resolution'
import { gitReadOptionsForWorktree, type GitRuntimeOptions } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { resolveGitCommonDir, resolveGitDir } from './resolve-git-dir'
import {
  canProveUnchangedByStamp,
  readHostFilesStamp,
  type WorktreeDiffStamp
} from './worktree-diff-stamp'

/** Effective Git config for one worktree; `files` is null when Node cannot stamp the files Git read (WSL). */
export type GitConfigSnapshot = {
  /** Canonical lowercase keys; the last value wins, as in Git. A bare key reads as `true`. */
  values: ReadonlyMap<string, string>
  /** Host paths of every config file Git read plus the standard ones it could create later. */
  files: readonly string[] | null
  /** info/attributes and the global attributes file, which shape diffs without being config. */
  attributeFiles: readonly string[] | null
}

type CachedSnapshot = {
  snapshot: GitConfigSnapshot
  /** Null when the read could not prove its files unchanged; the entry then only seeds the next stamp. */
  stamp: WorktreeDiffStamp | null
  atMs: number
}

// Includes and system config created after the read are not stamped; bound how long that can go unseen.
const GIT_CONFIG_SNAPSHOT_MAX_AGE_MS = 5 * 60_000
const snapshots = new BoundedMap<string, CachedSnapshot>({ maxEntries: 256 })

/** Read config once and reuse it while every stamped config file is unchanged, so polls spawn nothing. */
export async function readGitConfigSnapshot(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<GitConfigSnapshot | null> {
  const key = JSON.stringify([worktreePath, options.wslDistro ?? ''])
  const cached = snapshots.get(key)
  if (cached?.stamp && performance.now() - cached.atMs < GIT_CONFIG_SNAPSHOT_MAX_AGE_MS) {
    const stamp = await readHostFilesStamp(cached.snapshot.files ?? [])
    if (stamp && stamp.value === cached.stamp.value) {
      return cached.snapshot
    }
  }
  const locations = await resolveConfigLocations(worktreePath, options)
  // Stamp before reading, including files the last read named, so an edit during the read invalidates.
  const stampedFiles = locations
    ? [...new Set([...locations.candidates, ...(cached?.snapshot.files ?? [])])]
    : []
  const stampBefore = locations ? await readHostFilesStamp(stampedFiles) : null
  let stdout: string
  try {
    stdout = (
      await gitExecFileAsync(
        ['config', '--list', '--show-origin', '-z'],
        gitReadOptionsForWorktree(worktreePath, options)
      )
    ).stdout
  } catch {
    snapshots.delete(key)
    return null
  }
  const { values, originFiles } = parseConfigList(stdout, locations?.hostWorktreePath)
  if (!locations) {
    return { values, files: null, attributeFiles: null }
  }
  const files = [...new Set([...stampedFiles, ...originFiles])]
  const attributeFiles = [
    path.join(locations.commonDir, 'info', 'attributes'),
    globalAttributesFile(values.get('core.attributesfile'), locations.hostWorktreePath)
  ]
  const snapshot: GitConfigSnapshot = { values, files, attributeFiles }
  // Files first named by this read were not stamped before it; keep them so the next read can cache.
  const provable =
    stampBefore !== null &&
    files.length === stampedFiles.length &&
    canProveUnchangedByStamp(stampBefore)
  snapshots.set(key, {
    snapshot,
    stamp: provable ? stampBefore : null,
    atMs: performance.now()
  })
  return snapshot
}

type ConfigLocations = { hostWorktreePath: string; commonDir: string; candidates: string[] }

async function resolveConfigLocations(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<ConfigLocations | null> {
  // WSL Git reads config from the distro's own paths, which Node cannot stat as the host sees them.
  if (options.wslDistro || wslDistroForCommand(worktreePath)) {
    return null
  }
  const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options)
  if (!hostWorktreePath) {
    return null
  }
  const gitDir = await resolveGitDir(hostWorktreePath, options)
  const commonDir = await resolveGitCommonDir(gitDir)
  const home = process.env.HOME || homedir()
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  const candidates = [
    path.join(commonDir, 'config'),
    path.join(gitDir, 'config.worktree'),
    ...(process.env.GIT_CONFIG_GLOBAL
      ? [process.env.GIT_CONFIG_GLOBAL]
      : [path.join(home, '.gitconfig'), path.join(xdgConfigHome, 'git', 'config')]),
    ...(process.env.GIT_CONFIG_SYSTEM ? [process.env.GIT_CONFIG_SYSTEM] : [])
  ]
  return { hostWorktreePath, commonDir, candidates }
}

/** Parse `--list --show-origin -z`: `<origin>\0<key>\n<value>\0`, or `<key>\0` for a bare key. */
function parseConfigList(
  stdout: string,
  hostWorktreePath: string | undefined
): { values: Map<string, string>; originFiles: string[] } {
  const values = new Map<string, string>()
  const originFiles = new Set<string>()
  const records = stdout.split('\0')
  for (let index = 0; index + 1 < records.length; index += 2) {
    const origin = records[index]
    const entry = records[index + 1]
    if (origin.startsWith('file:') && hostWorktreePath) {
      // Repository files print relative to the worktree.
      originFiles.add(path.resolve(hostWorktreePath, origin.slice('file:'.length)))
    }
    const newline = entry.indexOf('\n')
    if (newline === -1) {
      values.set(entry, 'true')
    } else {
      values.set(entry.slice(0, newline), entry.slice(newline + 1))
    }
  }
  return { values, originFiles: [...originFiles] }
}

function globalAttributesFile(configured: string | undefined, hostWorktreePath: string): string {
  const home = process.env.HOME || homedir()
  if (configured) {
    return configured.startsWith('~/')
      ? path.join(home, configured.slice(2))
      : path.resolve(hostWorktreePath, configured)
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return path.join(xdgConfigHome, 'git', 'attributes')
}
