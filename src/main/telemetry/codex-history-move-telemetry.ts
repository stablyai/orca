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
 * Reports, once every managed host home has had a pass this run, how many moved and why the rest
 * are stuck. Without consent nothing is sent or kept.
 */
export class CodexHistoryMoveReport {
  private readonly outcomes = new Map<string, CodexHistoryMoveOutcome>()
  private marker: Promise<SentMarker> | null = null
  private queue: Promise<void> = Promise.resolve()
  // How many homes the last listing found: fewer outcomes than that can't cover them, so the
  // ownership reads behind a listing wait until enough passes have finished.
  private listedHomes = 0

  constructor(
    private readonly deps: {
      markerPath: () => string
      /** Comparison keys of the managed host homes that should be shared now; null when off. */
      sharedHomeKeys: () => string[] | null
      wslHomeCount: () => number
    }
  ) {}

  /** Settles once any report this outcome completes has been sent; never rejects. */
  record(homeKey: string, outcome: CodexHistoryMoveOutcome): Promise<void> {
    this.outcomes.set(homeKey, outcome)
    return this.refresh()
  }

  /** An unshared home's earlier outcome no longer says anything about its move. */
  forget(homeKey: string): void {
    this.outcomes.delete(homeKey)
  }

  /** Reports if every home has an outcome, for consent given after the passes settled. */
  refresh(): Promise<void> {
    this.queue = this.queue.then(() => this.reportIfComplete()).catch(() => {})
    return this.queue
  }

  private async reportIfComplete(): Promise<void> {
    const platform = process.platform
    if (
      (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') ||
      !isTelemetryEnabled()
    ) {
      return
    }
    const version = getAppEnvironment().getVersion()
    this.marker ??= readMarker(this.deps.markerPath()).then((saved) =>
      saved?.version === version ? saved : { version, sent: [] }
    )
    const marker = await this.marker
    if (marker.sent.length >= MAX_SENDS_PER_VERSION || this.outcomes.size < this.listedHomes) {
      return
    }
    const homes = this.deps.sharedHomeKeys()
    this.listedHomes = homes?.length ?? 0
    if (!homes || homes.length === 0 || homes.some((home) => !this.outcomes.has(home))) {
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
    const key = JSON.stringify(props)
    if (marker.sent.includes(key) || !track('codex_history_move_status', props)) {
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
