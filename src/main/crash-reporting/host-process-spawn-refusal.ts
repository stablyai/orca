import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import {
  spawnErrorCode,
  spawnRefusalReason,
  type SpawnRefusalReason
} from '../../shared/child-process/spawn-refusal-codes'
import { HOST_PROCESS_SPAWN_REFUSED_BREADCRUMB } from './crash-breadcrumb-store'
import { recordCoalescedDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

/**
 * A host that refused to create a process, recorded where a crash report can
 * see it.
 *
 * Why: on the a8b4e777 host every git spawn was already failing this way before
 * the renderer died, and Orca saw all of them - but only as the cause string on
 * a `git.exec` span, which no crash report carries. The report therefore showed
 * a renderer dying on a healthy-looking machine.
 *
 * A refusal to spawn is a statement about the host, not about git, so the
 * breadcrumb and the detail are named for the host.
 *
 * Scope, so a zero is not over-read: only git, gh, glab and the shared
 * command exec-file path report here. A pty, ripgrep or daemon spawn can be
 * refused on the same host and leave this count at zero.
 */

type CrashReportDetails = Record<string, CrashReportDetailValue>

/**
 * Why the host refused. Distinct markers, because they have different fixes.
 *
 * `spawn-unknown` is Windows returning a CreateProcess failure libuv has no
 * mapping for - the shape a commit refusal takes, and also the shape AV/EDR
 * interference takes, so it names the observation and not a diagnosis.
 */
export type HostSpawnRefusalMarker = SpawnRefusalReason | 'spawn-unknown'

type HostSpawnRefusal = {
  at: number
  program: string
  marker: HostSpawnRefusalMarker
}

// Enough to show a burst's shape; the count below is uncapped.
const MAX_TRACKED_SPAWN_REFUSALS = 16

// Why 30s and not something tighter: the coalesce map prunes every key against
// the calling window, so stay uniform with the other 30s coalescers.
const HOST_SPAWN_REFUSAL_COALESCE_MS = 30_000

const MAX_SPAWN_REFUSAL_DETAIL_LENGTH = 120

function programName(program: string): string {
  // Why not path.basename: the recorded program comes from whichever host ran
  // it, so a Windows path reaches a POSIX main during SSH work and vice versa.
  return program.split(/[/\\]/).at(-1) || program
}

function spawnSyscall(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('syscall' in error)) {
    return ''
  }
  return typeof error.syscall === 'string' ? error.syscall : ''
}

/** The marker this failure carries, or undefined when it is an ordinary
 *  non-zero exit rather than the host refusing to create a process. */
export function hostSpawnRefusalMarker(error: unknown): HostSpawnRefusalMarker | undefined {
  // Why gate on the syscall first: a code like UNKNOWN says nothing on its own,
  // and git's own exit codes - whose text reaches us inside the failure, up to
  // the 10 MB output cap - must never be read as the host running out of room.
  if (!spawnSyscall(error).startsWith('spawn')) {
    return undefined
  }
  return (
    spawnRefusalReason(error) ?? (spawnErrorCode(error) === 'UNKNOWN' ? 'spawn-unknown' : undefined)
  )
}

let refusals: HostSpawnRefusal[] = []
let observedCount = 0

/**
 * No-op unless `error` is the host refusing to create a process, so callers can
 * hand it every spawn failure without classifying first.
 */
export function noteHostProcessSpawnFailure(
  program: string,
  error: unknown,
  at: number = Date.now()
): void {
  const marker = hostSpawnRefusalMarker(error)
  if (!marker) {
    return
  }
  const name = programName(program)
  observedCount += 1
  refusals.push({ at, program: name, marker })
  if (refusals.length > MAX_TRACKED_SPAWN_REFUSALS) {
    refusals.shift()
  }
  // Two different bounds, because a refusal storm outlives any one window.
  // Coalescing caps the rate - the a8b4e777 host would otherwise have forced a
  // span plus a trace flush per refused spawn. Retention (the crumb name is a
  // retained key) caps the total: every window refreshes one slot instead of
  // pushing a 31st ring entry, so a storm lasting the whole pre-crash window
  // still cannot evict the trail this crumb exists to sit beside.
  try {
    recordCoalescedDurableCrashBreadcrumb({
      name: HOST_PROCESS_SPAWN_REFUSED_BREADCRUMB,
      data: { program: name, marker },
      coalesceKey: `${name} ${marker}`,
      minIntervalMs: HOST_SPAWN_REFUSAL_COALESCE_MS
    })
  } catch {
    // Why: two call sites are child `'error'` listeners, where a throw is an
    // uncaught exception that takes down main. The count above already landed.
  }
}

function joinTruncated(values: Iterable<string>): string {
  const all = [...values]
  const kept: string[] = []
  for (const value of all) {
    if (kept.length > 0 && [...kept, value].join(', ').length > MAX_SPAWN_REFUSAL_DETAIL_LENGTH) {
      break
    }
    kept.push(value)
  }
  const omitted = all.length - kept.length
  // Why the count rather than a silent cut: a shortened list reads as the whole
  // list, which is the unmarked-evidence misread this file exists to stop.
  return omitted > 0 ? `${kept.join(', ')}, +${omitted} more` : kept.join(', ')
}

/**
 * Always reports the count, zero included: an absent field reads as "nobody
 * looked", and "the host was still spawning fine" is a real finding.
 * The count is a session total; `hostProcessSpawnRefusedLastAgeMs` is what says
 * whether it was still happening at the time of death.
 */
export function hostProcessSpawnRefusalDetails(goneAt: number): CrashReportDetails {
  const details: CrashReportDetails = { hostProcessSpawnRefusedCount: observedCount }
  const last = refusals.at(-1)
  if (!last) {
    return details
  }
  details.hostProcessSpawnRefusedLastAgeMs = Math.max(0, goneAt - last.at)
  details.hostProcessSpawnRefusedMarkers = joinTruncated(
    new Set(refusals.map((refusal) => refusal.marker))
  )
  details.hostProcessSpawnRefusedPrograms = joinTruncated(
    new Set(refusals.map((refusal) => refusal.program))
  )
  return details
}

export function resetHostProcessSpawnRefusalForTest(): void {
  refusals = []
  observedCount = 0
}
