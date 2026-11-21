import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../shared/file-write/windows-retry-file-operations'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import type { EventProps } from '../../shared/telemetry/telemetry-event-classification'
import { isTelemetryEnabled, track } from './client'

type Props = EventProps<'codex_history_move_status'>

/** How a home's latest pass this run ended, for a home that should be shared. */
export type CodexHistoryMoveOutcome =
  | 'moved'
  | 'busy'
  | 'no_lock_helper'
  | 'refused'
  | 'incomplete'
  | 'failed'

// One report, plus one follow-up if the counts change (a busy home moving later in the version).
const MAX_SENDS_PER_VERSION = 2

type SentMarker = { version: string; sent: string[] }

async function readMarker(path: string): Promise<SentMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      typeof parsed.version === 'string' &&
      'sent' in parsed &&
      Array.isArray(parsed.sent)
    ) {
      return {
        version: parsed.version,
        sent: parsed.sent.filter((key): key is string => typeof key === 'string')
      }
    }
  } catch {
    // Missing or torn: at worst one extra report.
  }
  return null
}

const count = (value: number): number => Math.min(value, 1000)

/**
 * Reports, after a launch's passes for every managed host home, how many moved and why the rest
 * are stuck. Without consent nothing is sent or kept.
 */
export class CodexHistoryMoveReport {
  private readonly outcomes = new Map<string, CodexHistoryMoveOutcome>()
  private marker: Promise<SentMarker> | null = null
  private queue: Promise<void> = Promise.resolve()
  // Outcome changes so far, and the changes and listing the last full check saw: an unchanged
  // state skips relisting the homes (synchronous file checks on main) for a report already decided.
  private changes = 0
  private lastChecked: string | null = null

  constructor(
    private readonly deps: {
      markerPath: () => string
      wslHomeCount: () => number
      /**
       * The homes that should be shared now, null while sharing is off; read only right before a
       * report can go out.
       */
      currentHomes: () => string[] | null
    }
  ) {}

  record(homeKey: string, outcome: CodexHistoryMoveOutcome): void {
    if (this.outcomes.get(homeKey) !== outcome) {
      this.changes += 1
    }
    this.outcomes.set(homeKey, outcome)
  }

  /** An unshared home's earlier outcome no longer says anything about its move. */
  forget(homeKey: string): void {
    if (this.outcomes.delete(homeKey)) {
      this.changes += 1
    }
  }

  // With no host homes, an install with WSL homes still reports how many it has.
  private isComplete(homeKeys: string[]): boolean {
    return homeKeys.length > 0
      ? homeKeys.every((home) => this.outcomes.has(home))
      : this.deps.wslHomeCount() > 0
  }

  /**
   * `listedHomes`: the last listing seen; only once it is complete (and consent and the cap allow a
   * send) is the current listing read. Never rejects.
   */
  report(listedHomes: string[]): Promise<void> {
    this.queue = this.queue.then(() => this.reportIfComplete(listedHomes)).catch(() => {})
    return this.queue
  }

  private async reportIfComplete(listedHomes: string[]): Promise<void> {
    const platform = process.platform
    if (
      (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') ||
      !this.isComplete(listedHomes) ||
      !isTelemetryEnabled()
    ) {
      return
    }
    const version = getAppEnvironment().getVersion()
    this.marker ??= readMarker(this.deps.markerPath()).then((saved) =>
      saved?.version === version ? saved : { version, sent: [] }
    )
    const marker = await this.marker
    const state = (keys: string[]): string =>
      [this.changes, this.deps.wslHomeCount(), ...keys].join('\0')
    if (marker.sent.length >= MAX_SENDS_PER_VERSION || state(listedHomes) === this.lastChecked) {
      return
    }
    // Read after the marker loads: homes added, or sharing turned off, meanwhile.
    const homes = this.deps.currentHomes()
    if (!homes) {
      return
    }
    this.lastChecked = state(homes)
    if (!this.isComplete(homes)) {
      return
    }
    const tally = (outcome: CodexHistoryMoveOutcome): number =>
      count(homes.filter((home) => this.outcomes.get(home) === outcome).length)
    const props: Props = {
      platform,
      homes: count(homes.length),
      moved: tally('moved'),
      stuck_busy: tally('busy'),
      stuck_no_lock_helper: tally('no_lock_helper'),
      stuck_refused: tally('refused'),
      stuck_incomplete: tally('incomplete'),
      stuck_failed: tally('failed'),
      wsl_homes: count(this.deps.wslHomeCount())
    }
    // The one follow-up waits until no home is busy, so a second busy home's move isn't capped out.
    if (marker.sent.length > 0 && props.stuck_busy > 0) {
      return
    }
    const key = JSON.stringify(props)
    if (marker.sent.includes(key)) {
      return
    }
    if (!track('codex_history_move_status', props)) {
      // Refused (such as a full send budget): the next check tries again.
      this.lastChecked = null
      return
    }
    marker.sent.push(key)
    const target = this.deps.markerPath()
    // Staged, so a failed write never empties a marker that already counts a report.
    const staged = `${target}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(staged, `${JSON.stringify(marker)}\n`)
      await renameFileWithWindowsRetryAsync(staged, target)
    } catch (error) {
      await unlink(staged).catch(() => {})
      console.warn('[codex-account-history] Move telemetry marker not saved:', error)
    }
  }
}
