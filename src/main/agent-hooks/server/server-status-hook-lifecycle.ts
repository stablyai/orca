import { drainAgentHookSpool, type SpoolRecord } from '../../../shared/agent-hook-spool'
import { AgentHookServerRuntimeEnv } from './server-runtime-env'

export abstract class AgentHookServerStatusHookLifecycle extends AgentHookServerRuntimeEnv {
  setStatusHooksEnabled(enabled: boolean): void {
    if (enabled === this.statusHooksEnabled) {
      return
    }
    if (!enabled) {
      this.flushStatusPersistSync()
      this.stopOpenCodeBinderLoop()
      for (const timer of this.assistantMessageRetryTimers.values()) {
        clearTimeout(timer)
      }
      this.assistantMessageRetryTimers.clear()
      this.clearAllTranscriptPolls()
    }
    this.statusHooksEnabled = enabled
    if (enabled && this.server) {
      this.initializeStatusHookOwner()
      this.startOpenCodeBinderLoop()
    }
  }

  protected initializeStatusHookOwner(): void {
    if (!this.ownerStateInitialized) {
      // Why: hydrate before binding the listener so an early hook POST runs against a populated map.
      if (this.lastStatusFilePath) {
        this.hydrateLastStatusFromDisk()
      }
      this.captureHydratedAuthorityCommitments()
      // Drain before binding the listener so replay cannot race a live hook during startup.
      if (this.endpointDir) {
        const replayedPaneKeys = new Set<string>()
        drainAgentHookSpool({
          endpointDir: this.endpointDir,
          getPersistedLaunchTokenHash: (paneKey) =>
            this.hydratedLaunchTokenHashByPaneKey.get(this.resolvePaneKeyAlias(paneKey)),
          ingest: (record: SpoolRecord) => {
            this.ingestSpoolRecord(record)
            replayedPaneKeys.add(this.resolvePaneKeyAlias(record.paneKey))
          }
        })
        // Why: the owner may have died while Orca was down; check each replayed pane once.
        for (const paneKey of replayedPaneKeys) {
          void this.checkAgentPresence(paneKey)
        }
      }
      this.ownerStateInitialized = true
    }
  }
}
