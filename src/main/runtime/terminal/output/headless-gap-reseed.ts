import { OrcaRuntimeWithCreatePtyHeadlessTerminalState } from './headless-terminal-state'

const GAP_RESEED_BACKOFF_MAX_MS = 30_000

/** After the provider drops output, rebuild main's model from its snapshot; until then readers see a restoring screen, never the torn suffix. */
export abstract class OrcaRuntimeWithHeadlessGapReseed extends OrcaRuntimeWithCreatePtyHeadlessTerminalState {
  protected reseedHeadlessTerminalAfterDataGap(ptyId: string): void {
    const frontier = this.getPtyOutputSequence(ptyId)
    const pending = this.headlessTerminals.get(ptyId)
    if (pending?.gapReseedEndSeq !== undefined) {
      // One capture per PTY: a later gap only raises the frontier the snapshot must reach.
      pending.gapReseedEndSeq = frontier
      return
    }
    this.startGapReseed(ptyId, frontier, 0)
  }

  private startGapReseed(ptyId: string, frontier: number, attempt: number): void {
    const state = this.replaceHeadlessTerminalForProviderSeed(ptyId)
    state.gapReseedEndSeq = frontier
    // Why: the hidden renderer missed the dropped bytes too, so it must not seed this model; delivery treats the screen as restoring.
    this.headlessHydrationState.set(ptyId, 'pending')
    let outcome: 'seeded' | 'retry' | 'unavailable' = 'retry'
    state.writeChain = state.writeChain
      .then(async () => {
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        // Screen only: a storm repeats this, and history readers go to the provider instead.
        const { snapshot, late } = await this.awaitProviderTerminalBuffer(ptyId, {
          scrollbackRows: 0
        })
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        if (!snapshot) {
          outcome = late ? 'retry' : 'unavailable'
          return
        }
        // A capture that began before the latest gap still holds the dropped span's hole.
        if (snapshot.seq < (state.gapReseedEndSeq ?? frontier)) {
          return
        }
        if (await this.seedHeadlessFromProviderSnapshot(ptyId, state, snapshot)) {
          state.historyFromProvider = true
          outcome = 'seeded'
        }
      })
      .catch(() => {
        // A failed capture retries below; live bytes already chain behind this state.
      })
      .finally(() => {
        if (this.headlessTerminals.get(ptyId) !== state) {
          return
        }
        if (outcome === 'retry') {
          // Stay restoring; back off so a slow daemon or a sustained storm cannot loop captures.
          const delay =
            attempt < 2 ? 0 : Math.min(500 * 2 ** (attempt - 2), GAP_RESEED_BACKOFF_MAX_MS)
          const timer = setTimeout(() => {
            if (this.headlessTerminals.get(ptyId) === state) {
              this.startGapReseed(ptyId, state.gapReseedEndSeq ?? frontier, attempt + 1)
            }
          }, delay)
          timer.unref?.()
          return
        }
        state.gapReseedEndSeq = undefined
        this.headlessHydrationState.set(ptyId, 'done')
        // Seeded, or a provider without snapshots: the live model is the best there is, as before.
        this.providerSnapshotPreferredPtys.delete(ptyId)
      })
  }
}
