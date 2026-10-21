import { OrcaRuntimeWithSerializeAgentPromptSubmission } from '../input/terminal-agent-status-and-submission'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  confirmRootShellHasNoChildrenFromProcessTable,
  inspectionShowsShellAlone
} from '../../run-terminal-shell-alone'

export abstract class OrcaRuntimeWithRetirePtyAgentLaunchAuthorityOnConfirmedExit extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  private readonly launchExitProofs = new WeakSet<RuntimePtyWorktreeRecord>()

  /** Why: an OSC 133 D only says a command finished, and apps such as OMP print their own while
   *  running (#10923); launch identity is retired only once the agent's process is gone. */
  protected retirePtyAgentLaunchAuthorityOnConfirmedExit(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty || this.launchExitProofs.has(pty)) {
      return
    }
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    const retireHooks = Array.from(
      paneKeys,
      (paneKey) =>
        this.captureAgentHookCompatibilityRetirementFn?.(paneKey) ??
        (() => this.retireAgentHookCompatibilityAuthorityFn?.(paneKey))
    )
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    // Why always: the recheck also reconciles an exited hook agent's status row.
    const presence = this.recheckHookAgentPresenceForPty(ptyId)
    if (!pty.launchToken && !pty.launchAgent && !receipt) {
      return
    }
    const { incarnationId, launchToken, launchAgent } = pty
    const generation = this.getPtyLifecycleGeneration(ptyId)
    this.launchExitProofs.add(pty)
    const controller = this.ptyController
    const inspectOnHost = Boolean(
      process.platform === 'win32' || pty.connectionId || pty.isWsl || pty.wslDistro
    )
    const census = async (): Promise<boolean> => {
      if (inspectOnHost) {
        return inspectionShowsShellAlone(
          (await controller?.inspectProcess?.(ptyId, {
            scanChildProcesses: true,
            ...(incarnationId ? { expectedIncarnationId: incarnationId } : {})
          })) ?? null
        )
      }
      const rootPid = (await controller?.listProcesses?.(LOCAL_EXECUTION_HOST_ID))?.find(
        (pane) => pane.id === ptyId
      )?.rootProcessId
      return rootPid ? await confirmRootShellHasNoChildrenFromProcessTable(rootPid) : false
    }
    void this.confirmPtyAgentProcessGone(
      presence,
      census,
      Boolean(
        launchAgent ||
        Array.from(paneKeys).some((key) =>
          this.getAgentProviderSessionRowsForPaneFn?.(key).some(
            (row) => row.providerSession && row.agentType
          )
        )
      )
    )
      .then((gone) => {
        if (
          gone &&
          this.ptysById.get(ptyId) === pty &&
          pty.incarnationId === incarnationId &&
          pty.launchToken === launchToken &&
          pty.launchAgent === launchAgent &&
          this.restoredOrchestrationAuthorityByPtyId.get(ptyId) === receipt &&
          this.getPtyLifecycleGeneration(ptyId) === generation
        ) {
          this.retirePtyAgentLaunchAuthority(ptyId, () => retireHooks.forEach((retire) => retire()))
        }
      })
      .finally(() => this.launchExitProofs.delete(pty))
  }

  protected retirePtyAgentLaunchAuthority(ptyId: string, retireCapturedHooks?: () => void): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return
    }
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    if (!pty.launchToken && !receipt && !pty.launchAgent) {
      return
    }
    // Why: collect before the delete below, which drops the restored-authority receipt a
    // receipt-only pane's key comes from.
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    this.restoredOrchestrationAuthorityByPtyId.delete(ptyId)
    pty.launchToken = null
    pty.launchIncarnationId = null
    pty.launchAgent = null
    if (retireCapturedHooks) {
      retireCapturedHooks()
    } else {
      for (const paneKey of paneKeys) {
        this.retireAgentHookCompatibilityAuthorityFn?.(paneKey)
      }
    }
  }

  private async confirmPtyAgentProcessGone(
    presence: Promise<'live' | 'unverifiable' | 'exited' | null>,
    census: () => Promise<boolean>,
    capturedAgent: boolean
  ): Promise<boolean> {
    const verdict = await presence.catch(() => null)
    if (verdict === 'exited') {
      return true
    }
    if (verdict === 'live' || !capturedAgent) {
      return false
    }
    // Why: no checkable hook process (OMP, hooks off, remote row). Shell foreground is not enough:
    // a backgrounded agent still lives, so the host must see nothing else under the shell.
    try {
      return await census()
    } catch {
      return false
    }
  }
}
