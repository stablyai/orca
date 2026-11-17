import {
  terminalLaunchFacts,
  type TerminalLaunchResult
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { assertCliConversationWritersExited } from '../../agent-session/lifecycle/structured-agent-cli-writers'
import type { EnrichedAgentHookEventPayload } from '../../../agent-hooks/server/server-types'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../../../shared/agent-session/view/structured-agent-cli-conversation-adoption'
import { recordConversationKey } from '../../../native-chat/conversation-adoption/structured-conversation-key'
import type { StructuredAgentCliSourceRoute } from '../../../native-chat/conversation-adoption/structured-agent-cli-source'
import { OrcaRuntimeWithGetWorktreePs } from '../../workspaces/process-listing/workspace-process-listing'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { terminalOrphanExecutionOwnersEqual } from '../../terminal/adoption/terminal-orphan-owner'
import { terminalResumeRowMatches } from '../../../ipc/pty/host-env/saved-resume-ownership'
import { resolveObservedAgentStatusBinding } from '../../../ipc/agent-hooks/agent-status-ipc-boundary'

export abstract class OrcaRuntimeWithStructuredSessionCliWriterHost extends OrcaRuntimeWithGetWorktreePs {
  async isTerminalProviderSessionHeld(
    row: AgentStatusIpcPayload,
    connectionId: string | null,
    wslDistro: string | null,
    restoringPtyId?: string
  ): Promise<boolean> {
    const pty = this.getPtyRecordForPaneKey(row.paneKey)
    if (
      row.agentProcessEnded ||
      !pty ||
      pty.ptyId === restoringPtyId ||
      !terminalOrphanExecutionOwnersEqual({ connectionId, wslDistro }, pty) ||
      (row.worktreeId && row.worktreeId !== pty.worktreeId)
    ) {
      return false
    }
    const ptyId = pty.ptyId
    const incarnationId = pty.incarnationId
    const generation = this.getPtyLifecycleGeneration(pty.ptyId)
    const observed = this.readObservedAgentStatusPaneIdentityFn?.(row.paneKey)
    if (
      observed?.kind === 'observed' &&
      resolveObservedAgentStatusBinding(row.paneKey, this, observed).kind === 'unresolved'
    ) {
      return false
    }
    const observation = this.readHookCliWriterObservationFn?.(row)
    let exited = false
    try {
      exited = Boolean(
        observation && (await observation.presence()) === 'exited' && observation.current()
      )
    } catch {
      // Missing process evidence cannot release a conversation a PTY may still own.
    }
    if (!exited) {
      try {
        const live = await this.ptyController?.probePtyLiveness?.(ptyId)
        exited = live === false
      } catch {
        // A failed owner probe is unknown, not an exit.
      }
    }
    const currentPty = this.getPtyRecordForPaneKey(row.paneKey)
    if (!currentPty || currentPty.ptyId === restoringPtyId) {
      return false
    }
    if (currentPty.ptyId !== ptyId || currentPty.incarnationId !== incarnationId) {
      return true
    }
    if (exited) {
      return false
    }
    // A delayed probe must not assign an old conversation to a replacement process or row.
    return (
      this.getPtyRecordForPaneKey(row.paneKey) === pty &&
      terminalOrphanExecutionOwnersEqual({ connectionId, wslDistro }, pty) &&
      pty.incarnationId === incarnationId &&
      this.getPtyLifecycleGeneration(pty.ptyId) === generation &&
      this.getAgentProviderSessionRows().some(
        (current) =>
          current.paneKey === row.paneKey &&
          !current.agentProcessEnded &&
          terminalResumeRowMatches(current, row.agentType, row.providerSession)
      )
    )
  }

  getStructuredAgentCliSourceRoute(source: {
    workspaceId: string
    paneKey: string
  }): StructuredAgentCliSourceRoute {
    const pty = this.getPtyRecordForPaneKey(source.paneKey)
    if (!pty) {
      return 'unknown'
    }
    const pane = this.resolveTerminalPane(source.paneKey, source.workspaceId)
    if (pane.ptyId !== pty.ptyId || pty.worktreeId !== source.workspaceId) {
      return 'unknown'
    }
    return pty.connectionId ||
      pty.isWsl ||
      pty.wslDistro ||
      pane.executionHostId !== LOCAL_EXECUTION_HOST_ID
      ? 'unsupported'
      : 'native-local'
  }

  rememberSavedTerminalLaunchResult(ptyId: string, result: TerminalLaunchResult): void {
    const pty = this.ptysById.get(ptyId)
    if (pty && result.savedResumeDecision) {
      pty.savedTerminalLaunchResult = {
        incarnationId: pty.incarnationId,
        launchConfig: pty.launchConfig,
        launchToken: pty.launchToken,
        result: terminalLaunchFacts(result)
      }
    }
  }

  getTerminalLaunchResult(ptyId: string): TerminalLaunchResult | undefined {
    const pty = this.ptysById.get(ptyId)
    const saved = pty?.savedTerminalLaunchResult
    if (!pty) {
      return undefined
    }
    return terminalLaunchFacts({
      ...(saved?.incarnationId === pty.incarnationId &&
      saved.launchConfig === pty.launchConfig &&
      saved.launchToken === pty.launchToken
        ? saved.result
        : {}),
      launchAgent: pty.launchAgent ?? undefined,
      launchToken: pty.launchToken ?? undefined,
      launchConfig: pty.launchConfig ?? undefined
    })
  }

  /** A local hook that names its agent process supersedes the launch result saved for this PTY. */
  clearSavedTerminalLaunchOnAgentHook(event: EnrichedAgentHookEventPayload): void {
    const pty = this.getPtyRecordForPaneKey(event.paneKey)
    if (
      pty &&
      event.connectionId === null &&
      !event.structuredHost &&
      event.agentPresence?.process
    ) {
      delete pty.savedTerminalLaunchResult
    }
  }

  protected async assertStructuredChatAcquireAdmissible(record: AgentSessionRecord): Promise<void> {
    const head = record.providerHandleChain.at(-1)
    const key = head ? recordConversationKey(record, head) : null
    if (
      key?.id &&
      Object.values(CLI_CONVERSATION_ADOPTING_AGENTS).some((agents: readonly string[]) =>
        agents.includes(record.provider)
      )
    ) {
      await this.assertStructuredAdoptionTerminalWritersExited(record.provider, key.id)
    }
  }

  async assertStructuredAdoptionTerminalWritersExited(
    agent: StructuredAgentId,
    providerSessionId: string,
    closingPaneKeys?: readonly string[]
  ): Promise<void> {
    await assertCliConversationWritersExited(
      {
        rows: () => this.getAgentProviderSessionRows(),
        observation: (row) => this.readHookCliWriterObservationFn?.(row) ?? null,
        ptyResolver: () => {
          // One identity read for every key, rather than a scan of all terminals per key.
          const context = this.createTerminalIdentityReadContext()
          return (paneKey) => this.getPtyRecordForPaneKey(paneKey, context)?.ptyId ?? null
        }
      },
      agent,
      providerSessionId,
      closingPaneKeys
    )
  }
}
