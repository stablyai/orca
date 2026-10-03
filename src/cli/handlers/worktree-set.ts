import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatWorktreeShow, printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalNullableNumberFlag, getOptionalStringFlag } from '../flags'
import { getOptionalWorktreeSelector, getRequiredWorktreeSelector } from '../selectors'
import { getOptionalLinearIssueLinkFlag } from './worktree-linear-issue-link'
import { isValidWorkspaceUrl } from '../../shared/workspace-url'

function assertParentWorktreeFlagsCompatible(flags: Map<string, string | boolean>): void {
  if (flags.has('parent-worktree') && flags.get('no-parent') === true) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --parent-worktree or --no-parent, not both.'
    )
  }
  const parentWorktree = flags.get('parent-worktree')
  if (
    flags.has('parent-worktree') &&
    (typeof parentWorktree !== 'string' || parentWorktree === '')
  ) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --parent-worktree')
  }
}

/** `--url <link>` sets the workspace link; `--url null` (or empty) clears it. */
function getWorkspaceUrlFlag(flags: Map<string, string | boolean>): string | undefined {
  const raw = getOptionalStringFlag(flags, 'url')?.trim()
  if (raw === undefined) {
    return undefined
  }
  if (raw === '' || raw === 'null') {
    return ''
  }
  if (!isValidWorkspaceUrl(raw)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--url must be an absolute http(s) URL, got "${raw}".`
    )
  }
  return raw
}

export const worktreeSetHandler: CommandHandler = async ({ flags, client, cwd, json }) => {
  assertParentWorktreeFlagsCompatible(flags)
  const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue', {
    allowNull: true
  })
  const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
  const workspaceUrl = getWorkspaceUrlFlag(flags)
  const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.set', {
    worktree,
    displayName: getOptionalStringFlag(flags, 'display-name'),
    linkedIssue: getOptionalNullableNumberFlag(flags, 'issue'),
    ...linearIssueLink,
    comment: getOptionalStringFlag(flags, 'comment'),
    workspaceStatus: getOptionalStringFlag(flags, 'workspace-status'),
    workspaceUrl,
    parentWorktree: await getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client),
    noParent: flags.get('no-parent') === true
  })
  printResult(result, json, formatWorktreeShow)
}
