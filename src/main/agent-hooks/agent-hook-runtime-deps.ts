import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentStatusObservedPaneIdentities } from '../runtime/agent-status-observed-pane-identity'
import type { AgentHookServer } from './server'
import { isAgentStatusHooksEnabled } from '../../shared/agent-status-hooks-setting'

type RuntimeDeps = NonNullable<ConstructorParameters<typeof OrcaRuntimeService>[2]>

/** The hook-store bindings every runtime host (desktop, `orca serve`, orcad) gives its runtime. */
export function agentHookRuntimeDeps(
  server: AgentHookServer,
  observedPaneIdentities: Pick<AgentStatusObservedPaneIdentities, 'read'>,
  getSettings: () => Parameters<typeof isAgentStatusHooksEnabled>[0]
) {
  return {
    // Why: main's OSC parse is the only producer for a PTY agent, and this store is the only
    // place `worktree.ps` and the mobile projection read from.
    onTerminalAgentStatus: (event) => server.ingestTerminalStatus(event),
    onTerminalProgramStatusFacet: (event) => server.ingestProgramStatusFacet(event),
    onClaudeTerminalEvidence: (paneKey, evidence) =>
      server.observeClaudeTerminalEvidence(paneKey, evidence),
    getAgentStatusSnapshot: () =>
      server.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    getAgentStatusSnapshotForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
    // Why unfiltered: resume-identity rows carry the provider session mobile native chat
    // addresses transcripts by — Pi publishes identity that way and would otherwise be unreachable.
    getAgentProviderSessionSnapshot: () => server.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
    subscribeAgentProviderSessionChanges: (listener) =>
      server.subscribeProviderSessionChanges(listener),
    // Why captured rather than resolved at read: the fleet snapshot remints cached rows on every
    // read, so a row observed under one process otherwise acquires whatever owns the pane now.
    readObservedAgentStatusPaneIdentity: (paneKey) => observedPaneIdentities.read(paneKey),
    // Why: structured chats have no hooks, so the host writes their projections into the same store.
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
