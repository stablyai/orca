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

export abstract class OrcaRuntimeWithStructuredSessionCliWriterHost extends OrcaRuntimeWithGetWorktreePs {
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
          [...this.terminalSleepStateByWorktreeId.values()].some(
            (state) =>
              state.worktreeId === workspaceId &&
              (state.phase === 'sleeping' ||
                state.phase === 'partial' ||
                state.phase === 'stopping')
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
