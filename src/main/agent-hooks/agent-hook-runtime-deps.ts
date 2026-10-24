import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentStatusObservedPaneIdentities } from '../runtime/agent-status-observed-pane-identity'
import type { AgentHookServer } from './server'
import { isAgentStatusHooksEnabled } from '../../shared/agent-status-hooks-setting'

type RuntimeDeps = NonNullable<ConstructorParameters<typeof OrcaRuntimeService>[2]>

export function agentHookRuntimeDeps(
  server: AgentHookServer,
  observedPaneIdentities: Pick<AgentStatusObservedPaneIdentities, 'read'>,
  getSettings: () => Parameters<typeof isAgentStatusHooksEnabled>[0]
) {
  return {
    // OSC-derived PTY status feeds the store read by worktree.ps and mobile projections.
    onTerminalAgentStatus: (event) => server.ingestTerminalStatus(event),
    onTerminalProgramStatusFacet: (event) => server.ingestProgramStatusFacet(event),
    onClaudeTerminalEvidence: (paneKey, evidence) =>
      server.observeClaudeTerminalEvidence(paneKey, evidence),
    getAgentStatusSnapshot: () =>
      server.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    getAgentStatusSnapshotForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
    // Include resume identities so mobile can locate provider transcripts, including Pi sessions.
    getAgentProviderSessionSnapshot: () => server.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
    subscribeAgentProviderSessionChanges: (listener) =>
      server.subscribeProviderSessionChanges(listener),
    // Use identity captured at observation; resolving now could attribute cached rows to a new process.
    readObservedAgentStatusPaneIdentity: (paneKey) => observedPaneIdentities.read(paneKey),
    // Structured chats publish here directly because they have no hooks.
    structuredAgentStatusSink: {
      publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
      forget: (subject) => server.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        server.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject),
      readChildWorkRecords: (subject) => server.getStructuredChildWork(subject),
      readChildWorkHandles: (subject) => server.getStructuredChildWorkHandles(subject)
    },
    readHookCliWriterObservation: (row) => server.readCliWriterObservation(row),
    checkHookAgentPresence: (paneKey, exitedSince) =>
      exitedSince === undefined
        ? server.checkAgentPresence(paneKey)
        : server.checkAgentPresenceSince(paneKey, exitedSince),
    reconcileAgentStatusForEndedProcess: (paneKeys) =>
      server.reconcileEndedProcessForPaneKeys(paneKeys),
    forgetHookAgentExit: (paneKeys) => {
      for (const paneKey of paneKeys) {
        server.forgetAgentExit(paneKey)
      }
    },
    dropAgentStatusForRemovedWorktree: (worktreeId, host) =>
      server.dropStatusEntriesForRemovedWorktree(worktreeId, host),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(getSettings()) ? server.buildPtyEnv() : {}
  } satisfies RuntimeDeps
}
