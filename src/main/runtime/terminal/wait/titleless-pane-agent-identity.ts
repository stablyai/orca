import { detectTerminalWaitBlockedReason } from '../../terminal-wait-detection'
import {
  OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission,
  type TerminalInteractiveWaitEvidence
} from './terminal-wait-permission'

export abstract class OrcaRuntimeWithTitlelessPaneAgentIdentity extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  /** A hand-typed agent's startup dialogs emit no title, so no title transition asked which process owns the pane. */
  protected override readTerminalInteractiveWaitEvidence(
    handle: string,
    ptyId: string
  ): TerminalInteractiveWaitEvidence | Promise<TerminalInteractiveWaitEvidence | undefined> {
    // Only an unowned, untitled pane showing a dialog earns a foreground read; others answer synchronously.
    const identity = this.ptyForegroundAgent.identifyUnowned(ptyId, () => {
      const { terminal } = this.getTerminalWaitPermissionInputs(handle, ptyId)
      return (
        terminal.titleStatus === null &&
        detectTerminalWaitBlockedReason(
          this.readLiveTerminalScreenLines(ptyId)?.join('\n') ?? terminal.waitText
        ) !== null
      )
    })
    if (!identity) {
      return super.readTerminalInteractiveWaitEvidence(handle, ptyId)
    }
    // A timed-out scan cannot rule out a dialog, so it answers unknown rather than none.
    return identity.then((agent) =>
      agent === undefined || this.getTerminalAgentStatusPtyId(handle) !== ptyId
        ? undefined
        : super.readTerminalInteractiveWaitEvidence(handle, ptyId, agent)
    )
  }
}
