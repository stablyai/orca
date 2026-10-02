import type { RuntimeWorktreeSetResult } from '../../shared/runtime-worktree-contracts'
import type { CommandHandler } from '../dispatch/dispatch'
import { formatWorktreeShow } from './workspace-format'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { getOptionalStringFlag, getOptionalStringFlagAllowingEmpty } from '../arguments/flags'
import { getRequiredWorktreeSelector } from '../workspace-selection/workspace-selector'
import { assertWorktreeParentFlagsCompatible } from './worktree-create-parent-selector'
import { withWorktreeSelectorRecovery } from './worktree-selector-recovery'
import { setIfFolderWorkspace } from './folder-workspace-mutations'
import { printSetParentLine } from './worktree-lineage-summary'
import { resolveSetParentFields } from './worktree-parent-fields'
import { callNamingParentEnvironment } from './worktree-parent-environment'
import { getOptionalLinearIssueLinkFlag } from './worktree-linear-issue-link'
import { getWorktreeReadFlags } from './worktree-unread-flag'
import { getReviewTargetLinkFlags } from './worktree-review-link-flags'
import { assertGitLabLinkFlagProjectsMatch } from './worktree-gitlab-link-context'
import { isValidWorkspaceUrl } from '../../shared/workspace-url'

/** `--url <link>` sets the workspace link; `--url null` (or empty) clears it. */
export function getWorkspaceUrlFlag(flags: Map<string, string | boolean>): string | undefined {
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
  const parentSelector = getOptionalStringFlag(flags, 'parent-worktree')
  const readFlags = getWorktreeReadFlags(flags)
  const reviewLinks = getReviewTargetLinkFlags(flags, { nullable: true })
  const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue', {
    allowNull: true
  })
  const workspaceUrl = getWorkspaceUrlFlag(flags)
  const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
  if (await setIfFolderWorkspace(client, flags, worktree, json)) {
    return
  }
  await assertGitLabLinkFlagProjectsMatch(flags, client, { worktree })
  const parentFields = await resolveSetParentFields(flags, cwd, client)
  const pending = callNamingParentEnvironment<RuntimeWorktreeSetResult>(client, 'worktree.set', {
    worktree,
    displayName: getOptionalStringFlag(flags, 'display-name'),
    ...reviewLinks,
    ...linearIssueLink,
    // An explicit empty value clears the stored comment.
    comment: getOptionalStringFlagAllowingEmpty(flags, 'comment'),
    workspaceStatus: getOptionalStringFlag(flags, 'workspace-status'),
    ...readFlags,
    workspaceUrl,
    ...parentFields,
    noParent: flags.get('no-parent') === true
  })
  const result = await withWorktreeSelectorRecovery(
    pending,
    parentSelector
      ? [
          `Orca could not find the worktree selector "${worktree}" or the parent selector "${parentSelector}". The server did not identify which selector failed.`,
          'Check both selectors with orca worktree show --worktree <selector> --json.'
        ]
      : []
  )
  if (!json) {
    for (const warning of result.result.warnings ?? []) {
      console.error(`warning: ${warning.message}`)
    }
    printSetParentLine(result.result.worktree, parentFields)
  }
  printResult(result, json, formatWorktreeShow)
}
