import { hostSleepKey } from '../terminal/stop/worktree-terminal-sleep-key'
import {
  terminalLaunchFacts,
  type TerminalLaunchResult
} from '../../../shared/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import { OrcaRuntimeWithGetWorktreePs } from '../workspaces/workspace-process-listing'
import { getProviderForPty } from '../../ipc/pty/provider/registry'
import { LocalPtyProvider } from '../../providers/local-pty-provider'
import { inspectPtyProviderProcess } from '../../providers/pty-process-inspection'
import { inspectionShowsShellAlone } from '../run-terminal-shell-alone'
import {
  assertCliConversationWritersExited,
  posixCliWriterShellAlone,
  type CliWriterPane,
  type CliWriterTerminal
} from '../structured-agent-cli-writers'
import type { EnrichedAgentHookEventPayload } from '../../agent-hooks/server/server-types'
import {
  OPEN_CODE_WRITER_TOPOLOGY,
  cliWriterTopology
} from '../../agent-hooks/server/cli-writer-observation'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../../shared/structured-agent-cli-conversation-adoption'
import { recordConversationKey } from '../../native-chat/structured-conversation-key'

export abstract class OrcaRuntimeWithStructuredSessionCliWriterHost extends OrcaRuntimeWithGetWorktreePs {
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

  private cliWriterPtyPane(ptyId: string | null | undefined): CliWriterPane | null {
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    return pty?.connected && !pty.connectionId && !pty.isWsl && pty.incarnationId
      ? {
          ptyId: pty.ptyId,
          incarnationId: pty.incarnationId,
          identity: `${pty.ptyId}:${pty.incarnationId}`
        }
      : null
  }

  protected cliWriterTerminal(coordinates: {
    paneKey: string
    worktreeId?: string
  }): CliWriterTerminal | null {
    const record = this.getPtyRecordForPaneKey(coordinates.paneKey)
    if (!record || this.getPtyLivenessVerdict(record.ptyId)?.status === 'exited') {
      return null
    }
    try {
      const { ptyId } = this.resolveTerminalPane(coordinates.paneKey, coordinates.worktreeId ?? '')
      return { pane: this.cliWriterPtyPane(ptyId) }
    } catch {
      return { pane: null }
    }
  }

  /** On the PTY record, so a conversation link lives exactly as long as the execution it names. */
  recordCliWriterConversation(event: EnrichedAgentHookEventPayload): void {
    const agent =
      event.connectionId === null && !event.structuredHost ? event.payload.agentType : undefined
    const binding = event.providerSession
    const pty = agent && binding ? this.getPtyRecordForPaneKey(event.paneKey) : null
    if (!agent || !binding || !pty) {
      return
    }
    if (event.agentPresence?.process) {
      delete pty.savedTerminalLaunchResult
    }
    if (pty.cliConversations?.incarnationId !== pty.incarnationId) {
      pty.cliConversations = { incarnationId: pty.incarnationId, byKey: new Map() }
    }
    const key = `${agent}\0${binding.id}`
    const previous = pty.cliConversations.byKey.get(key)
    pty.cliConversations.byKey.set(key, {
      agent,
      id: binding.id,
      // An unmarked binding copy can't vouch either way, so it never revokes an earlier proof.
      paneOwned:
        cliWriterTopology(event) === 'pane-owned' ||
        (!(OPEN_CODE_WRITER_TOPOLOGY in binding) && previous?.paneOwned === true),
      process: event.agentPresence?.process ?? previous?.process
    })
  }

  /** Before a chat's agent spawns: refuses while a terminal may still write its head conversation.
   *  Never enters the session queue, so it can run inside an acquisition. */
  protected async assertStructuredChatAcquireAdmissible(record: AgentSessionRecord): Promise<void> {
    const head = record.providerHandleChain.at(-1)
    const key = head ? recordConversationKey(record, head) : null
    const adopts = Object.values(CLI_CONVERSATION_ADOPTING_AGENTS).some(
      (agents: readonly string[]) => agents.includes(record.provider)
    )
    if (!key?.id || !adopts) {
      return
    }
    await this.assertStructuredAdoptionTerminalWritersExited(record.provider, key.id)
  }

  async assertStructuredAdoptionTerminalWritersExited(
    agent: StructuredAgentId,
    providerSessionId: string,
    source?: { workspaceId: string; paneKey: string }
  ): Promise<void> {
    await assertCliConversationWritersExited(
      {
        rows: () => this.getAgentProviderSessionRows(),
        saved: () =>
          Object.values(
            this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)
              ?.sleepingAgentSessionsByPaneKey ?? {}
          ),
        observation: (row) => this.readHookCliWriterObservationFn?.(row) ?? null,
        terminal: (coordinates) => this.cliWriterTerminal(coordinates),
        links: () =>
          [...this.ptysById.values()].flatMap((pty) => {
            const conversations = pty.cliConversations
            if (
              !conversations ||
              conversations.incarnationId !== pty.incarnationId ||
              this.getPtyLivenessVerdict(pty.ptyId)?.status === 'exited'
            ) {
              return []
            }
            const terminal = () => ({
              pane: this.ptysById.get(pty.ptyId) === pty ? this.cliWriterPtyPane(pty.ptyId) : null
            })
            return [...conversations.byKey.values()].map((conversation) => ({
              ...conversation,
              worktreeId: pty.worktreeId,
              terminal
            }))
          }),
        sleeping: (workspaceId) =>
          this.terminalSleepStateByHostWorktree.has(
            hostSleepKey(LOCAL_EXECUTION_HOST_ID, workspaceId)
          ),
        shellAlone: async (pane) => {
          if (process.platform === 'win32') {
            const provider = getProviderForPty(pane.ptyId)
            const inspection = await inspectPtyProviderProcess(provider, pane.ptyId, {
              expectedIncarnationId: pane.incarnationId,
              scanChildProcesses: true,
              ignoreDetached: true
            })
            const evidence = inspection.foregroundProcessEvidence
            return (
              inspectionShowsShellAlone(inspection) &&
              (provider instanceof LocalPtyProvider ||
                (evidence?.ptyId === pane.ptyId &&
                  evidence.ptyIncarnationId === pane.incarnationId &&
                  evidence.verdict === 'unverifiable' &&
                  evidence.reason === 'windows_ssh_foreground_unavailable'))
            )
          }
          const processes = await this.ptyController?.listProcesses?.(LOCAL_EXECUTION_HOST_ID)
          const entry = processes?.find((candidate) => candidate.id === pane.ptyId)
          const pty = this.ptysById.get(pane.ptyId)
          return (
            !!entry?.rootProcessId &&
            !!entry.incarnationId &&
            entry.incarnationId === pty?.incarnationId &&
            (await posixCliWriterShellAlone(entry.rootProcessId))
          )
        }
      },
      agent,
      providerSessionId,
      source && { paneKey: source.paneKey, worktreeId: source.workspaceId }
    )
  }
}
