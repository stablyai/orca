import { lstat, realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import type { GitRepositoryStatusRequest } from '../../../shared/git/status/git-repository-status'
import {
  GIT_REPOSITORY_IGNORE_BATCH_SIZE,
  GIT_REPOSITORY_PROBE_BATCH_SIZE
} from '../../../shared/git/status/git-repository-status'
import type { GitStatusResult } from '../../../shared/git/status/git-status-types'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import {
  resolveGitMetadataPath,
  resolveWorktreeHostPath
} from '../../../shared/git/metadata/git-metadata-path'
import {
  joinWorktreeRelativePath,
  normalizeRuntimeRelativePath
} from '../../runtime/files/paths/runtime-relative-paths'
import { isDescendantOrEqualExact } from '../../ipc/filesystem/access/filesystem-path-containment'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { assertWslUncPathRunning } from '../../wsl/filesystem/wsl-unc-access-gate'
import { gitOptionsForWorktree, type GitRuntimeOptions } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import { getStatus } from './status-read'
import { checkIgnoredPaths } from './check-ignored-paths'

function scopedPath(value: string, root: string): string {
  if (value.includes('\0') || /^[a-zA-Z]:/.test(value)) {
    throw new Error('invalid_relative_path')
  }
  return normalizeRuntimeRelativePath(value, root)
}

/** The caller acquires workspace authority; this read never registers a repository or grants mutation access. */
export async function getRepositoryStatuses(
  workspacePath: string,
  request: GitRepositoryStatusRequest,
  options: GitRuntimeOptions = {}
): Promise<GitStatusResult> {
  options.signal?.throwIfAborted()
  const paths = request.repositoryPaths
  const intent = request.repositoryIntent
  if (
    !paths ||
    !intent ||
    !['probe', 'status', 'ignored'].includes(intent) ||
    paths.length > GIT_REPOSITORY_PROBE_BATCH_SIZE ||
    (intent !== 'probe' && paths.length !== 1) ||
    (request.repositoryQueryPaths?.length ?? 0) > GIT_REPOSITORY_IGNORE_BATCH_SIZE
  ) {
    throw new Error('invalid_repository_status_request')
  }
  await assertWslUncPathRunning(workspacePath, options.wslDistro)
  const hostRoot = resolveWorktreeHostPath(workspacePath, options) ?? workspacePath
  const normalized = paths.map((path) => scopedPath(path, hostRoot))
  const queryPaths = request.repositoryQueryPaths?.map((path) => scopedPath(path, hostRoot)) ?? []
  let root: string
  try {
    root = await realpath(windowsFsPath(hostRoot))
  } catch (error) {
    options.signal?.throwIfAborted()
    return {
      entries: [],
      conflictOperation: 'unknown',
      repositoryStatuses: normalized.map((path) => ({
        path,
        kind: isDefinitiveAbsence(error) ? 'absent' : 'unknown'
      }))
    }
  }
  const repositoryStatuses = await mapWithConcurrency(normalized, 4, async (path) => {
    options.signal?.throwIfAborted()
    let markerRead = false
    try {
      const candidate = joinWorktreeRelativePath(hostRoot, path)
      const physicalCandidate = windowsFsPath(candidate)
      if ((await lstat(physicalCandidate)).isSymbolicLink()) {
        return { path, kind: 'unknown' as const }
      }
      const canonical = await realpath(physicalCandidate)
      if (!isDescendantOrEqualExact(canonical, root)) {
        return { path, kind: 'unknown' as const }
      }
      const marker = await lstat(windowsFsPath(joinWorktreeRelativePath(candidate, '.git')))
      if (!marker.isDirectory() && !marker.isFile()) {
        return { path, kind: 'unknown' as const }
      }
      markerRead = true
      if (intent === 'probe') {
        return { path, kind: 'repository' as const }
      }
      // A broken marker must never let Git walk up and publish the containing repository's status.
      const { stdout } = await gitExecFileAsync(['rev-parse', '--show-toplevel'], {
        ...gitOptionsForWorktree(candidate, options),
        env: gitOptionalLocksDisabledEnv()
      })
      const topLevel = resolveGitMetadataPath(candidate, stdout.replace(/\r?\n$/, ''), options)
      if (!topLevel || relative(canonical, await realpath(windowsFsPath(topLevel))) !== '') {
        return { path, kind: 'unknown' as const }
      }
      if (intent === 'ignored') {
        return {
          path,
          kind: 'repository' as const,
          ignoredPaths: await checkIgnoredPaths(candidate, queryPaths, options)
        }
      }
      return {
        path,
        kind: 'repository' as const,
        status: await getStatus(candidate, {
          ...options,
          includeIgnored: false,
          includeLineStats: false,
          skipEffectiveUpstream: true
        })
      }
    } catch (error) {
      options.signal?.throwIfAborted()
      return {
        path,
        kind: !markerRead && isDefinitiveAbsence(error) ? ('absent' as const) : ('unknown' as const)
      }
    }
  })
  options.signal?.throwIfAborted()
  return { entries: [], conflictOperation: 'unknown', repositoryStatuses }
}
