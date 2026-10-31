import type { RepoKind } from '../shared/repo-types'
import { getPresentStringFlag } from './flags'
import { RuntimeClientError } from './runtime/types'

export function getOptionalRepoKind(flags: Map<string, string | boolean>): RepoKind | undefined {
  // Present-but-empty must fail rather than silently defaulting to git.
  const kind = getPresentStringFlag(flags, 'kind')
  if (kind === undefined) {
    return undefined
  }
  if (kind === 'git' || kind === 'folder') {
    return kind
  }
  throw new RuntimeClientError('invalid_argument', '--kind must be git or folder')
}
