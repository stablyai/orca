import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { BoundedMap } from '../../../../shared/collections/bounded-map'
import { canProveUnchangedByStamp, readHostFilesStamp } from '../input-stamps/worktree-diff-stamp'
import {
  resolveGitMetadataPath,
  resolveWorktreeHostPath
} from '../../../../shared/git/metadata/git-metadata-path'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  gitOptionsForWorktree,
  type GitRuntimeOptions
} from '../../command-runner/git-runtime-options'

const observations = new BoundedMap<string, { stamp: string; hash: string }>({ maxEntries: 128 })

/** The index bytes identify staged content, including changes to an already-staged path. */
export async function readRebaseIndexObservation(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--git-path', 'index'],
      gitOptionsForWorktree(worktreePath, options)
    )
    const rawPath = stdout.replace(/\r?\n$/, '')
    if (!rawPath || /[\r\n]/.test(rawPath)) {
      return null
    }
    const hostWorktree = resolveWorktreeHostPath(worktreePath, options)
    if (!hostWorktree) {
      return null
    }
    const indexPath = resolveGitMetadataPath(hostWorktree, rawPath, options)
    if (!indexPath) {
      return null
    }
    const before = await readHostFilesStamp([indexPath])
    const cached = observations.get(indexPath)
    if (before && canProveUnchangedByStamp(before) && cached?.stamp === before.value) {
      return cached.hash
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(indexPath)) {
      hash.update(chunk)
    }
    const after = await readHostFilesStamp([indexPath])
    if (!before || !after || before.value !== after.value) {
      return null
    }
    const value = hash.digest('hex')
    if (canProveUnchangedByStamp(before) && canProveUnchangedByStamp(after)) {
      observations.set(indexPath, { stamp: after.value, hash: value })
    }
    return value
  } catch {
    return null
  }
}
