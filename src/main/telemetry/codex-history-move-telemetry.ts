import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
    if (marker.sent.length >= MAX_SENDS_PER_VERSION) {
      return
    }
    const homes = this.deps.sharedHomeKeys()
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
    try {
      await mkdir(dirname(this.deps.markerPath()), { recursive: true })
      await writeFile(this.deps.markerPath(), `${JSON.stringify(marker)}\n`)
    } catch (error) {
      console.warn('[codex-account-history] Move telemetry marker not saved:', error)
    }
  }
}
