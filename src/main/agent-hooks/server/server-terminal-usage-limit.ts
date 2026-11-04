import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { TerminalUsageLimitSourceRequest } from '../../../shared/terminal-usage-limit-source-validation'
import { isWslHookRelayConnectionId } from '../../../shared/wsl-hook-relay-contract'
import {
  terminalUsageLimitCutMatches,
  terminalUsageLimitGuard,
  type TerminalUsageLimitCut
} from '../../../shared/agent-hook-listener/terminal-usage-limit-guard'
import { AgentHookServerAuthorityAliases } from './server-authority-aliases'

export abstract class AgentHookServerTerminalUsageLimit extends AgentHookServerAuthorityAliases {
  prepareTerminalUsageLimitContinuation(paneKey: string, expected: TerminalUsageLimitCut) {
    return terminalUsageLimitGuard(this.state, paneKey, expected)
  }

  prepareTerminalUsageLimitSource(paneKey: string, ptyId: string, expected: TerminalUsageLimitCut) {
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    const original = this.state.lastStatusByPaneKey.get(ownerPaneKey)
    if (!terminalUsageLimitCutMatches(original, expected)) {
      return null
    }
    if (original.payload.agentType !== 'claude' && original.payload.agentType !== 'codex') {
      return null
    }
    const source =
      original.payload.agentType === 'claude' ? ('claude' as const) : ('codex' as const)
    const connectionId = original.connectionId
    const remote = connectionId !== null
    if (remote && !isWslHookRelayConnectionId(connectionId)) {
      return null
    }
    const sourceOwner = remote ? this.capturePaneSourceOwner(ownerPaneKey, ptyId) : null
    if (remote && !sourceOwner) {
      return null
    }
    const relayCurrent =
      remote && sourceOwner
        ? this.relaySessions.capturePaneOwner(connectionId, sourceOwner.physicalPaneKey)
        : () => true
    const localCurrent = remote ? null : terminalUsageLimitGuard(this.state, ownerPaneKey, expected)
    if (!remote && !localCurrent) {
      return null
    }
    const matches = (row: AgentHookEventPayload | undefined) =>
      terminalUsageLimitCutMatches(row, expected) &&
      row.connectionId === connectionId &&
      row.worktreeId === original.worktreeId &&
      row.payload.agentType === original.payload.agentType &&
      row.launchToken === original.launchToken &&
      row.providerSession?.key === original.providerSession?.key &&
      row.providerSession?.transcriptPath === original.providerSession?.transcriptPath &&
      row.providerPromptId === original.providerPromptId &&
      row.agentPresence?.process?.pid === original.agentPresence?.process?.pid &&
      row.agentPresence?.process?.platform === original.agentPresence?.process?.platform &&
      row.agentPresence?.process?.startTime === original.agentPresence?.process?.startTime
    let current = true
    const unlisten = this.subscribeEnrichedStatus((row) => {
      if (row.paneKey === ownerPaneKey && !matches(row)) {
        current = false
      }
    })
    const uncleared = this.subscribePaneStatusClear((row) => {
      if ('paneKey' in row ? row.paneKey === ownerPaneKey : row.connectionId === connectionId) {
        current = false
      }
    })
    return {
      ...(remote && sourceOwner
        ? {
            remote: {
              connectionId,
              request: {
                paneKey: sourceOwner.physicalPaneKey,
                sessionId: expected.sessionId,
                turnEndedAt: expected.turnEndedAt,
                source,
                ...(original.launchToken !== undefined
                  ? { launchToken: original.launchToken }
                  : {}),
                ...(original.agentPresence?.process
                  ? { agentProcess: original.agentPresence.process }
                  : {})
              } satisfies TerminalUsageLimitSourceRequest
            }
          }
        : {}),
      isCurrent: () => {
        current =
          current &&
          this.server?.listening === true &&
          this.statusHooksEnabled &&
          this.resolvePaneKeyAlias(paneKey) === ownerPaneKey &&
          matches(this.state.lastStatusByPaneKey.get(ownerPaneKey)) &&
          (!sourceOwner || sourceOwner.isCurrent()) &&
          relayCurrent() &&
          (!localCurrent || localCurrent())
        return current
      },
      dispose: () => {
        current = false
        unlisten()
        uncleared()
      }
    }
  }
}
