import type { RepoKind } from '../shared/repo-types'
import { RuntimeClientError } from './runtime-client'

export function getOptionalRepoKind(flags: Map<string, string | boolean>): RepoKind | undefined {
  // Why: read the raw entry, not getOptionalStringFlag - that maps a bare `--kind`
  // (parsed as boolean true) to undefined, silently falling back to git.
  if (!flags.has('kind')) {
    return undefined
  }
  const kind = flags.get('kind')
  if (kind === 'git' || kind === 'folder') {
    return kind
  }
  throw new RuntimeClientError('invalid_argument', '--kind must be git or folder')
}
