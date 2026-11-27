import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
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
const MAX_RETRIES = 10
const inRootContext = AsyncLocalStorage.snapshot()

/** The run's one cleanup of old account copies; a pass stops it before touching a home. */
export class CodexAccountCopiesCleanupRun {
  private scheduled = false
  private retries = 0
  private worker: CodexAccountCopiesWorker | null = null

  constructor(
    private readonly deps: {
      passRunning: () => boolean
      /** The homes the launch's census listed; read without touching the disk. */
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
      // A pass that never settles must not keep a timer firing all run: a later launch retries.
      this.retries += 1
      if (this.retries <= MAX_RETRIES) {
        this.schedule(RETRY_MS)
      }
      return
    }
    const homes = this.deps.homes().filter((home) => this.deps.moveOutcome(home) === 'moved')
    // Only macOS and Windows can tell open files: elsewhere no worker starts.
    if (homes.length === 0 || (process.platform !== 'darwin' && process.platform !== 'win32')) {
      return
    }
    const worker = startCodexAccountCopiesWorker()
    this.worker = worker
    let deletedAny = false
    try {
      const tally = await cleanUpCodexAccountCopies({
        homes,
        storeHome: getSystemCodexHomePath(),
        moveOutcome: (home) => (this.worker === worker ? this.deps.moveOutcome(home) : null),
        shouldStop: () => this.worker !== worker || isCodexAccountHistoryWorkStopping(),
        worker,
        version: getAppEnvironment().getVersion(),
        managedAccountsRoot: join(getAppEnvironment().getPath('userData'), 'codex-accounts'),
        onDeleted: () => {
          deletedAny = true
        }
      })
      if (tally) {
        await reportCodexHistoryCopiesCleanup(this.deps.markerPath(), tally)
      }
    } catch (error) {
      console.warn('[codex-account-history] Old copies cleanup failed:', error)
    } finally {
      // Also when stopped midway: whatever was deleted no longer counts toward disk usage.
      if (deletedAny) {
        forgetCodexHistoryDiskUsage()
      }
      if (this.worker === worker) {
        this.worker = null
        await worker.stop()
      }
    }
  }
}
