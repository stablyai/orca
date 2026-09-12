import type { RepoKind } from '../shared/repo-types'
import { rejectValuelessFlag } from './flags'
import { RuntimeClientError } from './runtime-client'

/**
 * Repo kind for `repo add` and the `project setup-*` commands, read off the raw flag entry.
 * `getOptionalStringFlag` maps both damaged shapes - a bare `--kind` (parsed as `true`) and
 * `--kind=` (parsed as `''`) - to `undefined`, which reads as absent and silently registers a git
 * repo instead of the folder the caller asked for (#13358).
 */
export function getOptionalRepoKind(flags: Map<string, string | boolean>): RepoKind | undefined {
  if (!flags.has('kind')) {
    return undefined
  }
  const kind = flags.get('kind')
  // An empty value is the same mistake as a bare flag, so it gets the shared guard's message.
  rejectValuelessFlag(kind === '' ? true : kind, 'kind')
  if (kind === 'git' || kind === 'folder') {
    return kind
  }
  throw new RuntimeClientError('invalid_argument', '--kind must be git or folder')
}
