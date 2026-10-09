import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatWorktreeShow, printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalStringFlag } from '../flags'
import { getOptionalWorktreeSelector, getRequiredWorktreeSelector } from '../selectors'
import { assertWorktreeParentFlagsCompatible } from './worktree-create-parent-selector'
import { getOptionalLinearIssueLinkFlag } from './worktree-linear-issue-link'
import { getOptionalWorktreeUnreadFlag } from './worktree-unread-flag'
import { getReviewTargetLinkFlags } from './worktree-review-link-flags'
import { assertGitLabLinkFlagProjectsMatch } from './worktree-gitlab-link-context'
import { isValidWorkspaceUrl } from '../../shared/workspace-url'

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
  assertWorktreeParentFlagsCompatible(
    flags,
    'Choose either --parent-worktree or --no-parent, not both.'
  )
  const isUnread = getOptionalWorktreeUnreadFlag(flags)
  const reviewLinks = getReviewTargetLinkFlags(flags, { nullable: true })
  const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue', {
    allowNull: true
  })
  const workspaceUrl = getWorkspaceUrlFlag(flags)
  const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
  await assertGitLabLinkFlagProjectsMatch(flags, client, { worktree })
  const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.set', {
    worktree,
    displayName: getOptionalStringFlag(flags, 'display-name'),
    ...reviewLinks,
    ...linearIssueLink,
    comment: getOptionalStringFlag(flags, 'comment'),
    workspaceStatus: getOptionalStringFlag(flags, 'workspace-status'),
    isUnread,
    workspaceUrl,
    parentWorktree: await getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client),
    noParent: flags.get('no-parent') === true
  })
  printResult(result, json, formatWorktreeShow)
}
