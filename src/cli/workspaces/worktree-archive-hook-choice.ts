import { getPresentStringFlag } from '../arguments/flags'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  ARCHIVE_HOOK_UNDECIDED_CODE,
  type ArchiveHookApproval,
  type ArchiveHookApprovalRequest,
  type ArchiveHookChoice,
  type ArchiveHookReport
} from '../../shared/worktree/removal/archive-hook-decision'

export function getArchiveHookChoice(flags: Map<string, string | boolean>): ArchiveHookChoice {
  const archive = getPresentStringFlag(flags, 'archive')
  if (archive !== undefined && archive !== 'run' && archive !== 'skip' && archive !== 'inherit') {
    throw new RuntimeClientError('invalid_argument', '--archive must be one of: run, skip, inherit')
  }
  const runHooks = flags.get('run-hooks') === true
  if (runHooks && archive !== undefined && archive !== 'run') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --run-hooks or --archive skip|inherit, not both.'
    )
  }
  const choice = runHooks ? 'run' : (archive ?? 'inherit')
  if (choice === 'skip' && flags.get('allow-failed-archive-hook') === true) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--allow-failed-archive-hook waives a FAILED archive hook, but --archive skip runs no hook. Drop one of them.'
    )
  }
  return choice
}

export type ArchiveHookRequest = {
  runHooks: boolean
  approvedArchiveHash?: string
  report: Omit<ArchiveHookReport, 'ran'>
}

/** Inherit asks the desktop what its Delete would do without prompting, then pins an approved version. */
export async function resolveArchiveHookRequest(
  client: RuntimeClient,
  choice: ArchiveHookChoice,
  target: () => Promise<ArchiveHookApprovalRequest>
): Promise<ArchiveHookRequest> {
  if (choice !== 'inherit') {
    return { runHooks: choice === 'run', report: { decision: choice, reason: 'requested' } }
  }
  let approval: ArchiveHookApproval
  try {
    approval = (
      await client.call<ArchiveHookApproval>('worktree.archiveHookApproval', await target())
    ).result
  } catch (error) {
    // An older host can't say, yet its own Delete may run the hook and refuse on failure: don't guess.
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        ARCHIVE_HOOK_UNDECIDED_CODE,
        "This Orca host is older and can't tell whether the archive hook is approved. Nothing was deleted. Update Orca there, or pass --archive run to run the hook, or --archive skip to delete without it."
      )
    }
    throw error
  }
  if (approval.decision === 'run') {
    return {
      runHooks: true,
      ...(approval.approvedArchiveHash
        ? { approvedArchiveHash: approval.approvedArchiveHash }
        : {}),
      report: { decision: 'run', reason: 'approved' }
    }
  }
  if (approval.decision === 'needs-approval') {
    return { runHooks: false, report: { decision: 'skip', reason: 'not-approved' } }
  }
  throw new RuntimeClientError(
    ARCHIVE_HOOK_UNDECIDED_CODE,
    "Orca couldn't tell whether this workspace's archive hook is approved: the Orca app that holds hook approvals isn't reachable from this host, or the hook couldn't be read. Nothing was deleted. Pass --archive run to run the hook, or --archive skip to delete without it."
  )
}

export function archiveHookReport(
  request: ArchiveHookRequest,
  result: { archiveHookRan?: boolean | null }
): ArchiveHookReport {
  return { ...request.report, ran: result.archiveHookRan ?? null }
}

export function printArchiveHookWarning(report: ArchiveHookReport, json: boolean): void {
  if (json) {
    return
  }
  if (report.reason === 'not-approved') {
    console.error(
      "warning: The archive hook did not run: this version of the repository's orca.yaml script hasn't been approved in Orca. Pass --archive run to run it."
    )
  } else if (report.reason === 'older-host') {
    console.error(
      "warning: No Archive script ran: this Orca host is older and can't run a folder workspace's Archive script. Update Orca there to run it."
    )
  }
}

export function formatArchiveHookLine(report: ArchiveHookReport): string {
  if (report.ran === true) {
    return 'archiveHook: ran'
  }
  if (report.decision === 'skip') {
    return `archiveHook: skipped (${report.reason})`
  }
  return report.ran === false ? 'archiveHook: none ran' : 'archiveHook: outcome unknown'
}
