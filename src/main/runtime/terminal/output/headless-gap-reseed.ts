import { OrcaRuntimeWithCreatePtyHeadlessTerminalState } from './headless-terminal-state'
import type {
  GapRecovery,
  RuntimeHeadlessTerminal
} from '../records/runtime-terminal-state-records'
import { newGapRecovery, takeSeedCoveredQueries } from './provider-seed-covered-bytes'

const GAP_RESEED_MIN_INTERVAL_MS = 1_000
const GAP_RESEED_BACKOFF_MAX_MS = 30_000
const GAP_RESEED_WARN_AFTER_ATTEMPTS = 5
// Past the daemon client's own request timeout, so every capture settles before its slot frees.
const GAP_RESEED_CAPTURE_TIMEOUT_MS = 35_000
// Why: a storm gaps every hidden PTY at once; the daemon serializing them is the one already behind.
const GAP_RESEED_MAX_CONCURRENT_CAPTURES = 8

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref?.())

/** After the provider drops output, rebuild main's model from its snapshot; until then the screen is restoring, never the torn suffix. */
export abstract class OrcaRuntimeWithHeadlessGapReseed extends OrcaRuntimeWithCreatePtyHeadlessTerminalState {
  private gapCapturesInFlight = 0
  private readonly gapCaptureWaiters: (() => void)[] = []

  protected reseedHeadlessTerminalAfterDataGap(ptyId: string): void {
    if (this.ptysById.get(ptyId)?.connected === false) {
      // An exited PTY has no screen left to restore.
      this.disposeHeadlessTerminal(ptyId)
      return
    }
    const frontier = this.getPtyOutputSequence(ptyId)
    const current = this.headlessTerminals.get(ptyId)
    if (current?.gapReseed) {
      // One recovery per PTY: a later gap only raises the frontier its snapshot must reach.
      current.gapReseed.frontier = frontier
      return
    }
    this.startGapReseed(ptyId, newGapRecovery(frontier), 0, current?.gapReseedLastCaptureAt)
  }

  /** Execution-context correction mid-recovery restarts recovery, keeping the frontier and the restoring screen. */
  protected override replaceHeadlessTerminalAfterExecutionContextChange(
    ptyId: string,
    retryLateSeed = true
  ): void {
    const current = this.headlessTerminals.get(ptyId)
    if (current?.gapReseed) {
      const carried = newGapRecovery(current.gapReseed.frontier, current.gapReseed)
      this.startGapReseed(ptyId, carried, 0, current.gapReseedLastCaptureAt)
      return
    }
    super.replaceHeadlessTerminalAfterExecutionContextChange(ptyId, retryLateSeed)
  }

  private startGapReseed(
    ptyId: string,
    recovery: GapRecovery,
    attempt: number,
    lastCaptureAt: number | undefined
  ): void {
    const frontier = recovery.frontier
    const state = this.replaceHeadlessTerminalForProviderSeed(ptyId)
    state.gapReseed = recovery
    state.gapReseedLastCaptureAt = lastCaptureAt
    // Why: the hidden renderer missed the dropped bytes too, so it must not seed this model; readers treat the screen as restoring.
    this.headlessHydrationState.set(ptyId, 'pending')
    let seeded = false
    state.writeChain = state.writeChain
      .then(async () => {
        const wait = (state.gapReseedLastCaptureAt ?? 0) + GAP_RESEED_MIN_INTERVAL_MS - Date.now()
        if (wait > 0) {
          await delay(wait)
        }
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        await this.acquireGapCaptureSlot()
        try {
          if (this.headlessTerminals.get(ptyId) !== state) {
            return
          }
          state.gapReseedLastCaptureAt = Date.now()
          // From here a live byte may land after the snapshot, so it must queue rather than be assumed covered.
          recovery.capturing = true
          // Screen only: a storm repeats this, and history readers go to the provider instead.
          // Hold the slot for the whole request, not the readers' shorter wait, so late answers still land.
          const { snapshot } = await this.awaitProviderTerminalBuffer(
            ptyId,
            { scrollbackRows: 0 },
            { timeoutMs: GAP_RESEED_CAPTURE_TIMEOUT_MS }
          )
          // A null capture is a failed or late one: only snapshot-capable daemons send gaps.
          if (
            !snapshot ||
            this.headlessTerminals.get(ptyId) !== state ||
            snapshot.seq < (state.gapReseed?.frontier ?? frontier)
          ) {
            return
          }
          seeded =
            (await this.seedHeadlessFromProviderSnapshot(ptyId, state, snapshot)) &&
            // A gap during an asynchronous seed write leaves the frame behind again.
            snapshot.seq >= (state.gapReseed?.frontier ?? frontier)
          if (seeded) {
            // Owed replies, in arrival order, before any queued chunk's own.
            const owed = takeSeedCoveredQueries(recovery, snapshot.seq)
            if (owed) {
              await state.emulator.write(owed, { forwardQueryReplies: true })
            }
          }
        } finally {
          this.releaseGapCaptureSlot()
        }
      })
      .catch(() => {
        // A failed capture retries below; live bytes already chain behind this state.
      })
      .finally(() => {
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        if (seeded) {
          this.finishGapReseed(ptyId, state, recovery)
          return
        }
        if (attempt === GAP_RESEED_WARN_AFTER_ATTEMPTS) {
          console.warn('[terminal] dropped-output recovery still waiting for a current snapshot', {
            ptyIdSuffix: ptyId.slice(-10),
            attempts: attempt + 1
          })
        }
        // Stay restoring; back off so a slow daemon or a sustained storm cannot loop captures.
        const backoff =
          attempt < 2 ? 0 : Math.min(500 * 2 ** (attempt - 2), GAP_RESEED_BACKOFF_MAX_MS)
        setTimeout(() => {
          if (this.headlessTerminals.get(ptyId) === state && state.gapReseed) {
            const carried = newGapRecovery(state.gapReseed.frontier, state.gapReseed)
            this.startGapReseed(ptyId, carried, attempt + 1, state.gapReseedLastCaptureAt)
          }
        }, backoff).unref?.()
      })
  }

  private finishGapReseed(
    ptyId: string,
    state: RuntimeHeadlessTerminal,
    recovery: GapRecovery
  ): void {
    state.gapReseed = undefined
    state.historyFromProvider = true
    this.headlessHydrationState.set(ptyId, 'done')
    this.providerSnapshotPreferredPtys.delete(ptyId)
    // Only bytes that arrived while recovering, at their arrival time: an old notice still on screen is not news.
    if (recovery.suppressedTail) {
      this.observeHeadlessChunk(ptyId, state, recovery.suppressedTail, recovery.suppressedAt)
    }
  }

  private async acquireGapCaptureSlot(): Promise<void> {
    if (this.gapCapturesInFlight < GAP_RESEED_MAX_CONCURRENT_CAPTURES) {
      this.gapCapturesInFlight++
      return
    }
    await new Promise<void>((resolve) => this.gapCaptureWaiters.push(resolve))
  }

  private releaseGapCaptureSlot(): void {
    const next = this.gapCaptureWaiters.shift()
    if (next) {
      next()
    } else {
      this.gapCapturesInFlight--
    }
  }
}
