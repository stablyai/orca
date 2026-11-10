// A create with cloneInBackground returns once orcad is up; the repo keeps cloning in the VM
// (image/env/workspace-prelude.sh) and the desktop shows that as its own step by polling this.
import type { LifecycleDeps } from './lifecycle'
import { transition, type SandboxRow } from './store'

export type CloneStatus =
  | { state: 'none' }
  | { state: 'running'; percent: number; stage: 'download' | 'checkout' }
  | { state: 'done' }
  | { state: 'failed'; reason: CloneFailure }

/** Reasons the prelude writes; anything else reads as clone_failed. */
const FAILURES = ['clone_timeout', 'repo_unreachable', 'disk_full', 'clone_failed'] as const
export type CloneFailure = (typeof FAILURES)[number] | 'sandbox_stopped'

// The state line, then git's progress as runs of "<stage>\t<last percent>" (the log is \r-separated
// and grows with every update; only the stage boundaries and the latest percent matter).
export const CLONE_STATUS_SCRIPT = [
  'D="$HOME/.orca-sandbox/clone"',
  '[ -f "$D/state" ] || { echo none; exit 0; }',
  'head -n 1 "$D/state"',
  `tr '\\r' '\\n' <"$D/progress.log" 2>/dev/null | grep -oE '(Receiving objects|Resolving deltas|Updating files): +[0-9]+%' |`,
  `  awk '{ s=$0; sub(/: +[0-9]+%$/, "", s); p=$0; sub(/^.*: +/, "", p); sub(/%$/, "", p);`,
  `    if (s != last) { if (last != "") print last "\\t" lp; last = s } lp = p } END { if (last != "") print last "\\t" lp }'`
].join('\n')

const STATUS_TIMEOUT_MS = 15_000

/**
 * One overall percent from git's stages. A blobless clone downloads commits and trees (Receiving,
 * Resolving), then fetches the checkout's file contents (Receiving again) and writes them (Updating).
 */
export function parseCloneStatus(stdout: string): CloneStatus {
  const [stateLine = '', ...runLines] = stdout.trim().split('\n')
  const state = stateLine.trim()
  if (state === 'none' || state === '') {
    return { state: 'none' }
  }
  if (state === 'done') {
    return { state: 'done' }
  }
  if (state.startsWith('failed')) {
    const reason = state.slice('failed'.length).trim()
    return { state: 'failed', reason: (FAILURES as readonly string[]).includes(reason) ? (reason as CloneFailure) : 'clone_failed' }
  }
  const runs = runLines
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([stage, percent]) => ({ stage, percent: Math.min(100, Math.max(0, Number(percent) || 0)) }))
  const last = runs.at(-1)
  if (!last) {
    return { state: 'running', percent: 0, stage: 'download' }
  }
  const resolvedAt = runs.findIndex((run) => run.stage === 'Resolving deltas')
  const scale = (from: number, to: number) => Math.floor(from + ((to - from) * last.percent) / 100)
  if (runs.some((run) => run.stage === 'Updating files')) {
    return { state: 'running', percent: last.stage === 'Updating files' ? scale(90, 100) : 90, stage: 'checkout' }
  }
  const blobFetch = resolvedAt >= 0 && runs.slice(resolvedAt + 1).some((run) => run.stage === 'Receiving objects')
  if (blobFetch) {
    return { state: 'running', percent: last.stage === 'Receiving objects' ? scale(65, 90) : 90, stage: 'checkout' }
  }
  if (last.stage === 'Resolving deltas') {
    return { state: 'running', percent: scale(55, 65), stage: 'download' }
  }
  return { state: 'running', percent: scale(0, 55), stage: 'download' }
}

/** Reads the clone's progress in the VM; a failure is recorded on the row so it says why. */
export async function readCloneStatus(deps: LifecycleDeps, row: SandboxRow): Promise<CloneStatus> {
  if (row.status !== 'running' || !row.session_id) {
    return { state: 'failed', reason: 'sandbox_stopped' }
  }
  // A provider error propagates (503): the desktop polls again, it is not a clone failure.
  const { stdout } = await deps.provider.runCommand(row.session_id, {
    command: 'bash',
    args: ['-c', CLONE_STATUS_SCRIPT],
    timeoutMs: STATUS_TIMEOUT_MS
  })
  const status = parseCloneStatus(stdout)
  if (status.state === 'failed' && row.last_error !== status.reason) {
    await transition(deps.db, row, { last_error: status.reason }, deps.now()).catch(() => null)
  }
  return status
}
