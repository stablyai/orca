import { OrcaRuntimeWithVisibleSnapshotPreview } from './terminal-visible-state'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from '../wait/terminal-interactive-probe-budget'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { showsClaudeDialog } from '../wait/claude-open-dialog-hold'
import { detectTerminalWaitBlockedReason } from '../wait/terminal-wait-detection'
import { selectFreshExplicitAgentStatusRow } from '../../workspaces/process-listing/runtime-hook-agent-row-selection'

/** A permission dialog open when the runtime went down is still open after reattach, since no input reached
 *  the pane meanwhile (#35962); its restored hook row stands until a current screen rules the dialog out. */
export abstract class OrcaRuntimeWithRestoredAgentDialogScreen extends OrcaRuntimeWithVisibleSnapshotPreview {
  /** The screen that can rule a restored dialog out right now without provider I/O; null when only a read can tell.
   *  A provider-preferred grid may hold only the bytes since reattach, so there only the provider's frame counts. */
  private readCurrentDialogScreenWithoutRead(ptyId: string): readonly string[] | null {
    return this.providerSnapshotPreferredPtys.has(ptyId)
      ? (this.readCurrentProviderVisibleState(ptyId)?.lines ?? null)
      : (this.readCaughtUpRuledScreen(ptyId)?.lines ?? null)
  }

  /** Only a caught-up screen painted without any dialog rules one out; a blank grid may be a seed in flight.
   *  Once ruled out it stays out: later output (a prompt's own echo) outdates the frame, not the answer. */
  protected screenMayHoldAgentDialog(ptyId: string): boolean {
    if (!this.restoredAgentDialogRuledOutPtys.has(ptyId)) {
      this.ruleOutRestoredAgentDialog(ptyId, this.readCurrentDialogScreenWithoutRead(ptyId))
    }
    return !this.restoredAgentDialogRuledOutPtys.has(ptyId)
  }

  /** Reads the screen a restored permission wait stands on (#35962); undefined when none stands. */
  protected refreshRestoredWait(handle: string, ptyId: string): Promise<void> | undefined {
    const paneKey = this.getPaneKeyForTerminalHandle(handle)
    const row = selectFreshExplicitAgentStatusRow({
      handles: [handle],
      paneKeys: paneKey ? [paneKey] : [],
      hookRows: this.getAgentStatusSnapshotFn?.() ?? [],
      screenMayHoldDialog: () => this.screenMayHoldAgentDialog(ptyId)
    })
    return row?.restoredUnconfirmed === true
      ? this.refreshRestoredAgentDialogScreen(ptyId)
      : undefined
  }

  /** Reads a screen no current frame covers, for an async boundary about to judge a restored wait. */
  private async refreshRestoredAgentDialogScreen(ptyId: string): Promise<void> {
    if (this.restoredAgentDialogRuledOutPtys.has(ptyId)) {
      return
    }
    if (!this.providerSnapshotPreferredPtys.has(ptyId)) {
      this.ruleOutRestoredAgentDialog(
        ptyId,
        (await this.readCurrentTerminalWaitScreen(ptyId))?.lines
      )
      return
    }
    if (!this.readCurrentProviderVisibleState(ptyId)) {
      await withTimeout(
        this.captureProviderVisibleState(ptyId),
        TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS,
        null
      )
    }
    this.ruleOutRestoredAgentDialog(ptyId, this.readCurrentDialogScreenWithoutRead(ptyId))
  }

  private ruleOutRestoredAgentDialog(ptyId: string, lines: readonly string[] | null | undefined) {
    if (
      lines?.some((line) => line.trim() !== '') &&
      !showsClaudeDialog(lines) &&
      detectTerminalWaitBlockedReason(lines.join('\n')) === null
    ) {
      this.restoredAgentDialogRuledOutPtys.add(ptyId)
    }
  }
}
