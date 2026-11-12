import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { AgentStatusObservedPaneIdentities } from '../../runtime/terminal/identity/agent-status-observed-pane-identity'
import type { AgentHookServer } from '../server/agent-hook-server'
import { isAgentStatusHooksEnabled } from '../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'

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
    getPublicAgentStatusSnapshotForPane: (paneKey: string, terminalHandle?: string | null) =>
      server.getPublicStatusSnapshotForPane(paneKey, terminalHandle),
    // Include resume identities so mobile can locate provider transcripts, including Pi sessions.
    getAgentProviderSessionSnapshot: (tabId) =>
      tabId === undefined
        ? server.getStatusSnapshot()
        : server.getProviderSessionSourceRowsForTab(tabId),
    getAgentProviderSessionRowsForPane: (paneKey: string, terminalHandle?: string | null) =>
      server.getStatusRowsForPaneOrHandle(paneKey, terminalHandle),
    getAgentProviderSessionRowsForSession: (agent, session) =>
      server.getProviderSessionSourceRowsForSession(agent, session),
    getAcceptedAgentReply: (paneKey, leadTurnKey) => server.getAcceptedReply(paneKey, leadTurnKey),
    subscribeAgentStatusRowChanges: (listener) =>
      server.subscribeStatusRowMutations(({ before, after }) => {
        const paneKey = after?.paneKey ?? before?.paneKey
        if (paneKey) {
          listener(paneKey)
        }
      }),
    subscribeAgentProviderSessionChanges: (listener) =>
      server.subscribeStatusRowMutations(({ before, after }) => {
        const paneKey = after?.paneKey ?? before?.paneKey
        if (
          !paneKey ||
          (before?.providerSession?.id === after?.providerSession?.id &&
            before?.providerSession?.key === after?.providerSession?.key &&
            before?.agentType === after?.agentType &&
            before?.providerSession?.transcriptPath === after?.providerSession?.transcriptPath)
        ) {
          return
        }
        listener(
          server
            .getStatusSnapshotForPane(paneKey)
            .flatMap((row) =>
              row.providerSession ? [{ paneKey, sessionId: row.providerSession.id }] : []
            )
        )
      }),
    // Use identity captured at observation; resolving now could attribute cached rows to a new process.
    readObservedAgentStatusPaneIdentity: (paneKey) => observedPaneIdentities.read(paneKey),
    // Structured chats publish here directly because they have no hooks.
    structuredAgentStatusSink: {
      withSavedStatusGroup: (visit) => server.withSavedStructuredStatusGroup(visit),
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
    reconcileAgentStatusForEndedProcess: (paneKeys, sleep) => {
      const keys = [...paneKeys]
      if (sleep) {
        for (const paneKey of keys) {
          server.settleTerminalPaneSleep(paneKey, sleep.ptyId, sleep.incarnationId)
        }
      }
      server.reconcileEndedProcessForPaneKeys(keys)
    },
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
