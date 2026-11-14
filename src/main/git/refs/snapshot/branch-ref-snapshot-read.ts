import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitStreamStdout } from '../../command-runner/git-stream-stdout'
import type { LocalGitExecOptions } from '../resolution/repo-default-base-ref'
import { gitOptionsForWorktree as gitExecOptions } from '../../command-runner/git-runtime-options'
import {
  BRANCH_REF_SNAPSHOT_ARGS,
  parseBranchRef,
  type BranchRef
} from './branch-ref-snapshot-data'

export const BRANCH_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024

export type BranchRefSnapshot = {
  refs: readonly BranchRef[]
}

export type BranchSnapshotRetention = {
  reserve(bytes: number): boolean
  release(): void
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
