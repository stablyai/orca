import { gitExecFileAsync } from './command-runner/git-exec-file'
import { gitStreamStdout } from './command-runner/git-stream-stdout'
import type { LocalGitExecOptions } from './repo-default-base-ref'
import { gitOptionsForWorktree as gitExecOptions } from './git-runtime-options'
import {
  BRANCH_REF_SNAPSHOT_ARGS,
  parseBranchRef,
  type BranchRef
} from './branch-ref-snapshot-data'
import { resolveBaseRefSearchSelector } from './base-ref-search-selector'
import { createBranchRefProjection } from './branch-ref-snapshot-data'
import type { BaseRefSearchResult } from '../../shared/repo-types'

export const BRANCH_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024

export type BranchRefSnapshot = {
  refs: readonly BranchRef[]
}

export type BranchSnapshotRetention = {
  reserve(bytes: number): boolean
  release(): void
}

export class LegacyBranchSnapshotTooLarge extends Error {
  constructor(readonly intrinsic: boolean) {
    super('Branch selectors cannot be retained')
  }
}

export async function readBranchRefSnapshot(
  path: string,
  git: LocalGitExecOptions,
  onRef: (ref: BranchRef) => boolean | void,
  maxRetainedBytes = BRANCH_SNAPSHOT_MAX_BYTES,
  retention?: BranchSnapshotRetention
): Promise<{ snapshot: BranchRefSnapshot | null; oversized: boolean }> {
  let refs: BranchRef[] | null = []
  let estimatedBytes = 256
  let oversized = false
  if (retention && !retention.reserve(estimatedBytes)) {
    refs = null
  }
  await readRefLines(BRANCH_REF_SNAPSHOT_ARGS, path, git, (line) => {
    const ref = parseBranchRef(line)
    if (!ref) {
      return
    }
    const pageComplete = onRef(ref)
    if (refs) {
      const bytes =
        192 +
        2 *
          (ref.refName.length +
            ref.oid.length +
            ref.symref.length +
            ref.label.length +
            ref.searchName.length)
      estimatedBytes += bytes
      if (estimatedBytes > maxRetainedBytes || (retention && !retention.reserve(bytes))) {
        oversized = estimatedBytes > maxRetainedBytes && maxRetainedBytes > 0
        refs = null
        retention?.release()
      } else {
        refs.push(ref)
      }
    }
    return !refs && pageComplete === true
  }).catch((error: unknown) => {
    retention?.release()
    throw error
  })
  return { snapshot: refs ? { refs } : null, oversized }
}

export async function readBranchRemoteNames(
  path: string,
  git: LocalGitExecOptions
): Promise<string[]> {
  const { stdout } = await gitExecFileAsync(['remote'], {
    ...gitExecOptions(path, git),
    maxBuffer: 1024 * 1024
  })
  return stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
}

export async function readLegacyBranchSelectors(
  path: string,
  git: LocalGitExecOptions,
  retention?: BranchSnapshotRetention
): Promise<Map<string, string>> {
  const selectors = new Map<string, string>()
  let estimatedBytes = 128
  if (retention && !retention.reserve(estimatedBytes)) {
    throw new LegacyBranchSnapshotTooLarge(false)
  }
  await readRefLines(
    ['for-each-ref', '--format=%(refname)%00%(refname:short)', 'refs/heads', 'refs/remotes'],
    path,
    git,
    (line) => {
      const [full, short] = line.replace(/\r$/, '').split('\0')
      if (!full || !short) {
        return
      }
      const bytes = 96 + 2 * (full.length + short.length)
      estimatedBytes += bytes
      if (estimatedBytes > BRANCH_SNAPSHOT_MAX_BYTES || (retention && !retention.reserve(bytes))) {
        throw new LegacyBranchSnapshotTooLarge(estimatedBytes > BRANCH_SNAPSHOT_MAX_BYTES)
      }
      selectors.set(full, resolveBaseRefSearchSelector(full, short))
    }
  ).catch((error: unknown) => {
    retention?.release()
    throw error
  })
  return selectors
}

export async function readLegacyBranchPage(
  path: string,
  git: LocalGitExecOptions,
  remotes: string[],
  query: string,
  limit: number,
  remoteOnly: boolean
): Promise<BaseRefSearchResult[]> {
  const page: BaseRefSearchResult[] = []
  const project = createBranchRefProjection(remotes, query, remoteOnly)
  await readRefLines(
    BRANCH_REF_SNAPSHOT_ARGS.map((arg) =>
      arg.startsWith('--format=') ? `${arg}%00%(refname:short)` : arg
    ),
    path,
    git,
    (line) => {
      const ref = parseBranchRef(line)
      if (!ref) {
        return
      }
      const row = project(ref)
      const short = line.replace(/\r$/, '').split('\0')[4]
      const selector = short ? resolveBaseRefSearchSelector(ref.refName, short) : null
      if (row && selector && !selector.startsWith('refs/')) {
        page.push({ ...row, refName: selector })
      }
      return page.length >= limit
    }
  )
  return page
}

export async function readBranchWorktreePaths(
  path: string,
  git: LocalGitExecOptions,
  retention: BranchSnapshotRetention
): Promise<Map<string, string>> {
  const paths = new Map<string, string>()
  let retainable = retention.reserve(128)
  await readRefLines(
    ['for-each-ref', '--format=%(refname)%00%(worktreepath)', 'refs/heads'],
    path,
    git,
    (line) => {
      const [ref, occupied] = line.replace(/\r$/, '').split('\0')
      if (!ref?.startsWith('refs/heads/') || !occupied) {
        return
      }
      if (retainable && !retention.reserve(96 + 2 * (ref.length + occupied.length))) {
        // The caller still gets the complete current result; only retention is optional.
        retention.release()
        retainable = false
      }
      paths.set(ref.slice('refs/heads/'.length), occupied)
    }
  ).catch((error: unknown) => {
    retention.release()
    throw error
  })
  return paths
}

async function readRefLines(
  args: string[],
  path: string,
  git: LocalGitExecOptions,
  onLine: (line: string) => boolean | void
): Promise<void> {
  let carry = ''
  await gitStreamStdout(args, {
    ...gitExecOptions(path, git),
    // The parser retains a bounded line/page when a population cannot be retained.
    maxBuffer: Number.MAX_SAFE_INTEGER,
    maxStderrBuffer: 64 * 1024,
    onStdout: (chunk) => {
      const lines = (carry + chunk).split('\n')
      carry = lines.pop() ?? ''
      if (carry.length > 64 * 1024) {
        throw new Error('Git returned an oversized branch ref record')
      }
      for (const line of lines) {
        if (onLine(line) === true) {
          carry = ''
          return true
        }
      }
      return false
    }
  })
  if (carry) {
    onLine(carry)
  }
}
