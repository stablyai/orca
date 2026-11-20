import { getPresentStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import type {
  ArchiveHookChoice,
  ArchiveHookReport
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

/** Older hosts drop `archiveHooks` and follow `runHooks`, which keeps their previous behavior. */
export function archiveHookRequest(choice: ArchiveHookChoice): {
  archiveHooks: ArchiveHookChoice
  runHooks: boolean
} {
  return { archiveHooks: choice, runHooks: choice === 'run' }
}

export function printArchiveHookWarning(
  choice: ArchiveHookChoice,
  report: ArchiveHookReport | undefined,
  json: boolean
): void {
  if (json) {
    return
  }
  if (!report) {
    if (choice === 'inherit') {
      console.error(
        "warning: The host didn't report an archive hook decision (it may predate --archive); it runs the archive hook only with --archive run."
      )
    }
    return
  }
  if (report.reason === 'not-approved') {
    console.error(
      "warning: The archive hook did not run: this version of the repository's orca.yaml script hasn't been approved in Orca. Pass --archive run to run it."
    )
  } else if (report.reason === 'unverifiable') {
    console.error(
      "warning: No archive hook ran: Orca can't check this workspace's hook approval on its host. Pass --archive run to run it."
    )
  }
}
