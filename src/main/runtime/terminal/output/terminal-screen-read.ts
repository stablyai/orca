import type { GapScreenIdentity } from '../records/runtime-terminal-state-records'
import { OrcaRuntimeWithRestoredAgentDialogScreen } from './restored-agent-dialog-screen'
import { readKeptGapScreen, type KeptGapScreen } from './gap-recovery-screen'
import type { RuntimeTerminalProjection } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

/** Explicit screen reads, including a rebuilding screen's newest correct frame. */
export abstract class OrcaRuntimeWithScreenRead extends OrcaRuntimeWithRestoredAgentDialogScreen {
  protected gapScreenStream(ptyId: string): GapScreenIdentity {
    return {
      generation: this.getPtyLifecycleGeneration(ptyId),
      anchorRevision: this.providerSequenceAnchorRevisions.get(ptyId)
    }
  }

  protected trustedGapScreenStream(ptyId: string): GapScreenIdentity | null {
    return this.readWholeScreenModel(ptyId) ? this.gapScreenStream(ptyId) : null
  }

  private readKeptScreen(ptyId: string): Promise<KeptGapScreen | null> {
    return readKeptGapScreen(this.headlessTerminals.get(ptyId)?.gapReseed, () =>
      this.gapScreenStream(ptyId)
    )
  }

  /** A rendered screen for an explicit screen read, or null when none can be known now. */
  protected async readScreenProjection(
    ptyId: string,
    limit: number | undefined
  ): Promise<RuntimeTerminalProjection | KeptGapScreen | null> {
    const visibleState = await this.readVisibleTerminalState(ptyId)
    if (visibleState) {
      return visibleState
    }
    // A rebuilding screen answers at once from its newest correct frame: the daemon is busy with recovery's captures.
    // A screen the provider owned before the gap already took main's cached, bounded provider path above.
    if (this.headlessTerminals.get(ptyId)?.gapReseed) {
      return this.readKeptScreen(ptyId)
    }
    // A rebuild that finished during the lookup left a trusted model to answer, not the daemon.
    if (this.readWholeScreenModel(ptyId)) {
      const settled = await this.readVisibleTerminalState(ptyId)
      if (settled) {
        return settled
      }
    }
    // A gap during that lookup started a new rebuild: the same answer as above.
    if (this.headlessTerminals.get(ptyId)?.gapReseed) {
      return this.readKeptScreen(ptyId)
    }
    return this.readProviderTerminalTailLines(ptyId, limit, { visibleScreenOnly: true })
  }
}
