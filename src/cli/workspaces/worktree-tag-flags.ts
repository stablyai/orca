import { normalizeWorktreeTags, worktreeTagKey } from '../../shared/worktree/metadata/worktree-tags'
import { getRepeatedStringFlag, rejectValuelessFlag } from '../arguments/flags'
import { WORKTREE_TAGS_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/protocol-version'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'

export const WORKTREE_TAG_FLAGS = ['tag', 'untag', 'tags'] as const

export function hasWorktreeTagFlags(flags: Map<string, string | boolean>): boolean {
  return WORKTREE_TAG_FLAGS.some((name) => flags.has(name))
}

/** `--tags` replaces the set (`null` or `""` clears it); then `--tag` adds and `--untag` removes. */
export function resolveWorktreeTagFlags(
  flags: Map<string, string | boolean>,
  currentTags: readonly string[] | undefined
): string[] {
  const replacement = flags.get('tags')
  rejectValuelessFlag(replacement, 'tags')
  const base =
    typeof replacement !== 'string'
      ? normalizeWorktreeTags(currentTags)
      : replacement.trim() === 'null'
        ? []
        : replacement.split(',')
  const removed = new Set(getRepeatedStringFlag(flags, 'untag').map(worktreeTagKey))
  return normalizeWorktreeTags(
    [...base, ...getRepeatedStringFlag(flags, 'tag')].filter(
      (tag) => !removed.has(worktreeTagKey(tag))
    )
  )
}

/** Tags to send with `worktree set`, or undefined when no tag flag was passed. */
export async function getWorktreeSetTags(
  flags: Map<string, string | boolean>,
  client: RuntimeClient,
  worktree: string
): Promise<string[] | undefined> {
  if (!hasWorktreeTagFlags(flags)) {
    return undefined
  }
  // Why: an older host strips `tags` from worktree.set and still reports success.
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(WORKTREE_TAGS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host does not support workspace tags. Nothing was changed; update Orca on the execution host.'
    )
  }
  if (flags.has('tags')) {
    return resolveWorktreeTagFlags(flags, [])
  }
  const current = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree
  })
  return resolveWorktreeTagFlags(flags, current.result.worktree.tags)
}
