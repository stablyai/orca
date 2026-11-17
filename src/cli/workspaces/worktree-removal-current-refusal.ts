import { getOptionalStringFlag } from '../arguments/flags'
import { assertLocalCwdWorktreeSelector } from '../hosts/local-environment-selector'
import { RuntimeClientError } from '../runtime/types'
import type { RuntimeClient } from '../runtime/client'
import { resolveCurrentWorktreeSelector } from '../workspace-selection/workspace-selector'
import { quoteCliCommandArgument } from '../arguments/shell-command-quote'

/** What current/active names right now: one selector, the ambiguous choices, or nothing. */
async function describeCurrent(
  cwd: string,
  client: RuntimeClient
): Promise<{ selectors: string[]; resolution: 'resolved' | 'ambiguous' | 'unresolved' }> {
  try {
    return {
      selectors: [await resolveCurrentWorktreeSelector(cwd, client, 'current')],
      resolution: 'resolved'
    }
  } catch (error) {
    const data =
      error instanceof RuntimeClientError && error.code === 'selector_ambiguous' ? error.data : null
    const choices =
      typeof data === 'object' && data !== null && 'validSelectorForms' in data
        ? data.validSelectorForms
        : undefined
    return Array.isArray(choices) && choices.every((choice) => typeof choice === 'string')
      ? { selectors: choices, resolution: 'ambiguous' }
      : { selectors: [], resolution: 'unresolved' }
  }
}

/**
 * Removal needs an explicit workspace, as `git worktree remove` needs a path: a cwd shortcut could
 * delete a different workspace than the one the caller has in mind. Shared by every `worktree rm`
 * kind, so it runs before the command decides between a worktree and a folder workspace.
 */
export async function refuseCurrentForRemoval(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<void> {
  const value = getOptionalStringFlag(flags, 'worktree')
  if (value !== 'current' && value !== 'active') {
    return
  }
  // Remote cwd can't be resolved; that refusal already names the environment to list.
  assertLocalCwdWorktreeSelector(value, client)
  const { selectors, resolution } = await describeCurrent(cwd, client)
  const flagsFor = selectors.map((selector) => `--worktree ${quoteCliCommandArgument(selector)}`)
  const named =
    resolution === 'resolved'
      ? ` Here, ${value} is ${flagsFor[0]}; pass that instead.`
      : resolution === 'ambiguous'
        ? ` Here, ${value} matches more than one workspace; pass the one you mean.`
        : ''
  throw new RuntimeClientError(
    'invalid_argument',
    `orca worktree rm needs an explicit workspace; --worktree ${value} is not accepted for removal.${named}`,
    {
      current: { resolution, selectors },
      nextSteps: [
        ...flagsFor.map((flag) => `orca worktree rm ${flag}`),
        ...(resolution === 'unresolved'
          ? ['Find the workspace with `orca worktree ps --json` and pass its `address.worktree`.']
          : [])
      ]
    }
  )
}
