import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord,
  RuntimeWorktreeCreateResult,
  RuntimeWorktreeRemoveResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatWorktreeList, formatWorktreePs, formatWorktreeShow, printResult } from '../format'
import {
  annotateOmittedHostScope,
  type WithAnnotatedHostScope
} from '../omitted-host-scope-selectors'
import { RuntimeClientError } from '../runtime-client'
import {
  getOptionalNullableNumberFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag
} from '../flags'
import { assertResourceReservationEcho } from '../resource-reservation-flags'
import {
  getOptionalWorktreeSelector,
  getRequiredWorktreeSelector,
  resolveCurrentWorktreeSelector
} from '../selectors'
import { printLineageSummary } from './worktree-lineage-summary'
import { assertWorkspaceTargetFlagsCompatible } from '../worktree-project-target'
import { assertCreateParentFlagsCompatible } from './worktree-create-parent-selector'
import { getOptionalLinearIssueLinkFlag } from './worktree-linear-issue-link'
import { buildWorktreeCreateParams } from './worktree-create-params'

type HookWarningResult = {
  warning?: string
}

type PreservedBranchResult = {
  preservedBranch?: {
    branchName: string
  }
}

function printHookWarning(result: HookWarningResult, json: boolean): void {
  if (!json && result.warning) {
    console.error(`warning: ${result.warning}`)
  }
}

function printPreservedBranchWarning(result: PreservedBranchResult, json: boolean): void {
  if (!json && result.preservedBranch) {
    console.error(
      `warning: local branch "${result.preservedBranch.branchName}" was kept because Git could not safely delete it`
    )
  }
}

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

export const WORKTREE_HANDLERS: Record<string, CommandHandler> = {
  'worktree ps': async ({ flags, client, json }) => {
    const result = await client.call<WithAnnotatedHostScope<RuntimeWorktreePsResult>>(
      'worktree.ps',
      { limit: getOptionalPositiveIntegerFlag(flags, 'limit') }
    )
    await annotateOmittedHostScope(client, result.result)
    printResult(result, json, formatWorktreePs)
  },
  'worktree list': async ({ flags, client, json }) => {
    const result = await client.call<WithAnnotatedHostScope<RuntimeWorktreeListResult>>(
      'worktree.list',
      {
        repo: getOptionalStringFlag(flags, 'repo'),
        limit: getOptionalPositiveIntegerFlag(flags, 'limit')
      }
    )
    await annotateOmittedHostScope(client, result.result)
    printResult(result, json, formatWorktreeList)
  },
  'worktree show': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    })
    printResult(result, json, formatWorktreeShow)
  },
  'worktree current': async ({ client, cwd, json }) => {
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: await resolveCurrentWorktreeSelector(cwd, client)
    })
    printResult(result, json, formatWorktreeShow)
  },
  'worktree create': async ({ flags, client, cwd, json }) => {
    assertCreateParentFlagsCompatible(flags)
    assertWorkspaceTargetFlagsCompatible(flags)
    const { params, reservation } = await buildWorktreeCreateParams({ flags, client, cwd })
    const result = await client.call<RuntimeWorktreeCreateResult>('worktree.create', params)
    // Why: an older host drops the unknown `reservation` param and answers with an ordinary
    // create, leaving the caller believing a binding it cannot see was persisted.
    if (reservation) {
      assertResourceReservationEcho(reservation, result.result.worktree.reservation, 'workspace')
    }
    printHookWarning(result.result, json)
    printLineageSummary(result.result, json)
    printResult(result, json, formatWorktreeShow)
  },
  'worktree set': async ({ flags, client, cwd, json }) => {
    assertParentWorktreeFlagsCompatible(flags)
    const linearIssueLink = getOptionalLinearIssueLinkFlag(flags, 'linear-issue', {
      allowNull: true
    })
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.set', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      linkedIssue: getOptionalNullableNumberFlag(flags, 'issue'),
      ...linearIssueLink,
      comment: getOptionalStringFlag(flags, 'comment'),
      workspaceStatus: getOptionalStringFlag(flags, 'workspace-status'),
      parentWorktree: await getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client),
      noParent: flags.get('no-parent') === true
    })
    printResult(result, json, formatWorktreeShow)
  },
  'worktree rm': async ({ flags, client, cwd, json }) => {
    const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    const resolved = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree
    })
    const hostId = resolved.result.worktree.hostId
    if (!hostId) {
      throw new RuntimeClientError(
        'worktree_host_unresolved',
        'Orca cannot tell which host owns this workspace. Refresh projects and try again.'
      )
    }
    const result = await client.call<RuntimeWorktreeRemoveResult>('worktree.rm', {
      worktree,
      hostId,
      force: flags.get('force') === true,
      // Why (#11960): --force is explicit here, so it may also waive PTY-stop proof.
      allowUnverifiedPtyStop: flags.get('force') === true,
      runHooks: flags.get('run-hooks') === true
    })
    printHookWarning(result.result, json)
    printPreservedBranchWarning(result.result, json)
    printResult(result, json, (value) => `removed: ${value.removed}`)
  }
}
