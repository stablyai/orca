import { resolve } from 'node:path'
import {
  createGitObjectQuarantine,
  inheritedObjectStore,
  type GitObjectQuarantine
} from '../shared/git-object-quarantine'
import { expandTilde } from './context'
import type { GitExec } from './git-handler-ops'

/** Scratch object store for throwaway Git writes; the relay and Git share one host and spelling. */
export function createRelayGitObjectQuarantine(
  git: GitExec,
  repoPath: string
): GitObjectQuarantine {
  return createGitObjectQuarantine(async () => {
    // Why the relay's own env: relay Git inherits it unchanged (buildRelayGitEnv).
    const inherited = inheritedObjectStore(process.env)
    if (!inherited) {
      return undefined
    }
    const { stdout } = await git(['rev-parse', '--git-common-dir'], repoPath)
    const commonDir = stdout.replace(/\r?\n$/, '')
    if (!commonDir) {
      return undefined
    }
    // Why: Git 2.25 may print the common dir relative to the command's cwd.
    const objects = resolve(expandTilde(repoPath), commonDir, 'objects')
    return { hostPath: objects, gitPath: objects, ...inherited }
  })
}
