import { OrcaRuntimeWithAgentOrchestrationDependencies } from '../orchestration/crew/runtime-agent-orchestration-dependencies'
import { RuntimePtyForegroundAgent } from '../terminal/lifecycle/runtime-pty-foreground-agent'
import { OpenCodeRunLifetimeStatus } from '../terminal/output/opencode-run-lifetime-status'
import { readLocalPtyForegroundCommandLine } from '../terminal/lifecycle/local-pty-foreground-command-line'
import { isAgentStatusHooksEnabledForAgent } from '../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'

/** What runs in each terminal's foreground, and the process-observed lifetime of an OpenCode run. */
export abstract class OrcaRuntimeWithPtyForegroundState extends OrcaRuntimeWithAgentOrchestrationDependencies {
  protected readonly ptyForegroundAgent = new RuntimePtyForegroundAgent({
    getController: () => this.ptyController,
    getPty: (ptyId) => this.ptysById.get(ptyId) ?? null,
    touchSnapshot: (ptyId) => this.touchMobileSessionSnapshotsForPty(ptyId),
    finishDelayedSnapshot: (ptyId, changed) => {
      if (this.mobileSessionTabListeners.size > 0) {
        this.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
      }
      if (!changed) {
        this.touchMobileSessionSnapshotsForPty(ptyId)
      }
    }
  })

  protected readonly openCodeRunLifetime = new OpenCodeRunLifetimeStatus({
    isStopping: (ptyId) =>
      this.intentionalPtyStops
        .claimExit(ptyId, this.ptysById.get(ptyId)?.incarnationId)
        .includes('reversible'),
    isObservablePty: (ptyId) => {
      const pty = this.ptysById.get(ptyId)
      // SSH/WSL foregrounds belong to the host/guest, not this process.
      return !!pty && !pty.connectionId && !pty.wslDistro && !this.wslDistroByPtyId.has(ptyId)
    },
    isStatusEnabled: (agent) =>
      isAgentStatusHooksEnabledForAgent(this.store?.getSettings?.(), agent),
    readForegroundProcessName: async (ptyId) => {
      const read = await this.ptyForegroundAgent.read(ptyId)
      return read?.available ? read.process : null
    },
    readForegroundCommandLine: (ptyId, foregroundProcess) =>
      readLocalPtyForegroundCommandLine(ptyId, foregroundProcess),
    // Renderer command-finished can drop unchanged status rows; publish Done after that fact.
    publish: (ptyId, payload, yieldsToHookSince) =>
      this.runAfterPendingTerminalSideEffectFacts(ptyId, () =>
        this.emitTerminalAgentStatusEvents(
          ptyId,
          { payloads: [payload] },
          { origin: 'process', yieldsToHookSince }
        )
      ),
    now: () => Date.now()
  })
}
