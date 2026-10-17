import type { RepoKind } from '../shared/repo-types'
import { RuntimeClientError } from './runtime-client'

// Why the raw entry rather than getOptionalStringFlag: that accessor maps `--kind=` to undefined,
// which here would read as "no kind given" and silently pick one instead of rejecting the input.
export function getOptionalRepoKind(flags: Map<string, string | boolean>): RepoKind | undefined {
  if (!flags.has('kind')) {
    return undefined
  }
  const kind = flags.get('kind')
  if (kind === 'git' || kind === 'folder') {
    return kind
  }
  throw new RuntimeClientError('invalid_argument', '--kind must be git or folder')
}
