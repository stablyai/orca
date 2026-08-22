import { normalizeBeadsIssueDetails, type BeadsIssueDetails } from '../../shared/beads-types'
import {
  getBdVersionInfo,
  isBdNotInitializedOutput,
  runBd,
  type BeadsExecutionTarget
} from './client'
import {
  bdFailureOutput,
  isBdIssueNotFoundOutput,
  isPlausibleBeadsIssueId,
  parseBdJsonArray
} from './issues'

/** details:null means bd is missing/unsupported/uninitialized or the id is unknown; real load failures throw. */
export type BeadsIssueDetailsResult = { details: BeadsIssueDetails | null }

export async function getBeadsIssueDetails(
  target: BeadsExecutionTarget,
  id: string
): Promise<BeadsIssueDetailsResult> {
  if (!isPlausibleBeadsIssueId(id)) {
    return { details: null }
  }
  const info = await getBdVersionInfo(target)
  if (!info.installed || !info.supported) {
    return { details: null }
  }
  const result = await runBd(target, [
    'show',
    id,
    '--include-dependents',
    '--include-comments',
    '--json'
  ])
  if (result.exitCode !== 0) {
    if (
      result.spawnFailed ||
      isBdNotInitializedOutput(bdFailureOutput(result)) ||
      // Same taxonomy as getBeadsIssue: a missing/stale id exits 1 on bd 1.1.2.
      isBdIssueNotFoundOutput(bdFailureOutput(result))
    ) {
      return { details: null }
    }
    throw new Error(`bd show failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  // `bd show --json` wraps the issue in an array.
  return { details: normalizeBeadsIssueDetails(parseBdJsonArray(result.stdout)[0]) }
}

export async function addBeadsIssueComment(
  target: BeadsExecutionTarget,
  id: string,
  text: string
): Promise<BeadsIssueDetailsResult> {
  if (!isPlausibleBeadsIssueId(id)) {
    throw new Error(`bd comment rejected: implausible issue id ${JSON.stringify(id)}`)
  }
  const trimmedText = text.trim()
  if (!trimmedText) {
    throw new Error('bd comment rejected: comment text is empty')
  }
  const info = await getBdVersionInfo(target)
  if (!info.installed || !info.supported) {
    return { details: null }
  }
  // Why: `--` stops flag parsing so leading-dash comment text posts verbatim (probed on bd 1.1.2).
  const result = await runBd(target, ['comment', id, '--json', '--', trimmedText])
  if (result.exitCode !== 0) {
    if (result.spawnFailed || isBdNotInitializedOutput(bdFailureOutput(result))) {
      return { details: null }
    }
    // Unknown id, etc. — a mutation must fail loudly, never no-op.
    throw new Error(`bd comment failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  // Why: bd comment's payload is just the new comment; callers need the fresh full detail view.
  const refreshed = await getBeadsIssueDetails(target, id).catch(
    (): BeadsIssueDetailsResult => ({ details: null })
  )
  if (!refreshed.details) {
    throw new Error(`bd comment succeeded but the refreshed issue ${id} could not be read back`)
  }
  return refreshed
}
