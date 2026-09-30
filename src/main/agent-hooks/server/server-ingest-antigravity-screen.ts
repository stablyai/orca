import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'
import { isWslHookRelayConnectionId } from '../../../shared/wsl-hook-relay-contract'

export type AntigravityScreenPermissionObservation = {
  baseline: Pick<AgentStatusIpcPayload, 'paneKey' | 'terminalHandle' | 'observation'>
} & ({ command: string } | { command: null; clearedState: 'working' | 'done' })

const SCREEN_APPROVAL_PREFIX = '{"approval":{"source":"antigravity-screen",'

export abstract class AgentHookServerIngestAntigravityScreen extends AgentHookServerIngestNormalization {
  ingestAntigravityScreenPermission(request: AntigravityScreenPermissionObservation): boolean {
    const { baseline, command } = request
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This server's canonical row writer stores enriched events in the shared listener map.
    const previous = this.state.lastStatusByPaneKey.get(baseline.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const expected = baseline.observation
    const current = previous?.observation
    if (
      !previous ||
      previous.restoredUnconfirmed ||
      // Why: SSH mirrors stay on their execution host; a WSL relay row is this host's own pty.
      (previous.connectionId && !isWslHookRelayConnectionId(previous.connectionId)) ||
      previous.payload.agentType !== 'antigravity' ||
      !baseline.terminalHandle ||
      (previous.terminalHandle !== undefined &&
        previous.terminalHandle !== baseline.terminalHandle) ||
      !expected ||
      !current ||
      current.authorityId !== expected.authorityId ||
      current.incarnation !== expected.incarnation ||
      current.revision !== expected.revision ||
      this.getAgentStatusDisposition(baseline.paneKey) !== 'accept'
    ) {
      return false
    }
    const ownsPrompt =
      current.origin === 'process' &&
      previous.payload.state === 'waiting' &&
      previous.payload.interactivePrompt?.startsWith(SCREEN_APPROVAL_PREFIX) === true
    if (command === null ? !ownsPrompt : previous.payload.state !== 'working' && !ownsPrompt) {
      return false
    }
    const interactivePrompt =
      command === null
        ? undefined
        : JSON.stringify({
            approval: {
              source: 'antigravity-screen',
              tool: previous.payload.toolName ?? 'run_command',
              summary: command
            }
          })
    if (interactivePrompt === previous.payload.interactivePrompt) {
      return true
    }
    // Only a positively identified working or idle screen can clear our approval.
    return (
      this.applyNormalizedStatus(
        {
          paneKey: previous.paneKey,
          tabId: previous.tabId,
          worktreeId: previous.worktreeId,
          connectionId: previous.connectionId,
          terminalHandle: baseline.terminalHandle,
          providerSession: previous.providerSession,
          payload: {
            ...previous.payload,
            state: request.command === null ? request.clearedState : 'waiting',
            ...(command === null ? { toolName: undefined, toolInput: undefined } : {}),
            interactivePrompt
          }
        },
        undefined,
        'process'
      ) !== undefined
    )
  }
}
