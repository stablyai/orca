import { AsyncLocalStorage } from 'node:async_hooks'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { isCodexAccountHistoryWorkStopping } from './codex-account-history-index'
import {
  cleanUpCodexAccountCopies,
  startCodexAccountCopiesWorker,
  type CodexAccountCopiesWorker
} from './codex-account-copies-cleanup'
import { reportCodexHistoryCopiesCleanup } from '../../../telemetry/codex-history-copies-telemetry'
import { forgetCodexHistoryDiskUsage } from '../disk-usage/codex-history-disk-usage'
import type { CodexHistoryMoveOutcome } from '../../../telemetry/codex-history-move-telemetry'

// Once per run, a while after the launch's passes settle, and only while no pass runs.
const DELAY_MS = 2 * 60_000
const RETRY_MS = 60_000
const inRootContext = AsyncLocalStorage.snapshot()

/** The run's one cleanup of old account copies; a pass stops it before touching a home. */
export class CodexAccountCopiesCleanupRun {
  private scheduled = false
  private worker: CodexAccountCopiesWorker | null = null

  constructor(
    private readonly deps: {
      passRunning: () => boolean
      homes: () => string[]
      moveOutcome: (accountHome: string) => CodexHistoryMoveOutcome | null
      markerPath: () => string
    }
  ) {}

  schedule(delayMs = DELAY_MS): void {
    if (this.scheduled && delayMs === DELAY_MS) {
      return
    }
    this.scheduled = true
    const timer = inRootContext(() => setTimeout(() => void this.run(), delayMs))
    timer.unref?.()
  }

  async stop(): Promise<void> {
    const worker = this.worker
    this.worker = null
    await worker?.stop().catch(() => {})
  }

  private async run(): Promise<void> {
    if (isCodexAccountHistoryWorkStopping()) {
      return
    }
    if (this.deps.passRunning()) {
      this.schedule(RETRY_MS)
      return
    }
    const homes = this.deps.homes().filter((home) => this.deps.moveOutcome(home) === 'moved')
    if (homes.length === 0) {
      return
    }
    const worker = startCodexAccountCopiesWorker()
    this.worker = worker
    try {
      const tally = await cleanUpCodexAccountCopies({
        homes,
        storeHome: getSystemCodexHomePath(),
        moveOutcome: (home) => (this.worker === worker ? this.deps.moveOutcome(home) : null),
        shouldStop: () => this.worker !== worker || isCodexAccountHistoryWorkStopping(),
        worker
      })
      if (tally && tally.deleted > 0) {
        forgetCodexHistoryDiskUsage()
      }
      if (tally) {
        await reportCodexHistoryCopiesCleanup(this.deps.markerPath(), tally)
      }
    } catch (error) {
      console.warn('[codex-account-history] Old copies cleanup failed:', error)
    } finally {
      if (this.worker === worker) {
        this.worker = null
        await worker.stop()
      }
    }
  }
}
