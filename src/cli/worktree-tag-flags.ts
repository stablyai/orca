import { normalizeWorktreeTags } from '../shared/worktree/worktree-tags'
import { getRepeatedStringFlag, rejectValuelessFlag } from './flags'
import { WORKTREE_TAGS_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import type { RuntimeStatus } from '../shared/runtime-types'
import { RuntimeClientError, type RuntimeClient } from './runtime-client'

export const WORKTREE_TAG_FLAGS = ['tag', 'untag', 'tags'] as const

export type WorktreeSetTagParams = { tags?: string[]; addTags?: string[]; removeTags?: string[] }

export function hasWorktreeTagFlags(flags: Map<string, string | boolean>): boolean {
  return WORKTREE_TAG_FLAGS.some((name) => flags.has(name))
}

/** `--tags` replaces the set (`null` or `""` clears it); `--tag`/`--untag` edit it on the host. */
export function parseWorktreeTagFlags(flags: Map<string, string | boolean>): WorktreeSetTagParams {
  const replacement = flags.get('tags')
  rejectValuelessFlag(replacement, 'tags')
  const addTags = normalizeWorktreeTags(getRepeatedStringFlag(flags, 'tag'))
  const removeTags = normalizeWorktreeTags(getRepeatedStringFlag(flags, 'untag'))
  return {
    ...(typeof replacement === 'string'
      ? { tags: replacement.trim() === 'null' ? [] : normalizeWorktreeTags(replacement.split(',')) }
      : {}),
    ...(addTags.length > 0 ? { addTags } : {}),
    ...(removeTags.length > 0 ? { removeTags } : {})
  }
}

/** Tag params for `worktree set`, or undefined when no tag flag was passed. */
export async function getWorktreeSetTagParams(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<WorktreeSetTagParams | undefined> {
  if (!hasWorktreeTagFlags(flags)) {
    return undefined
  }
  const params = parseWorktreeTagFlags(flags)
  // Why: an older host strips tag fields from worktree.set and still reports success.
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(WORKTREE_TAGS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host does not support workspace tags. Nothing was changed; update Orca on the execution host.'
    )
  }
  return params
}
