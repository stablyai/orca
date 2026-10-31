import { prepareTerminalAgentStopRelease } from './terminal-agent-stop-release'
import { windowsPaneAgentStopRows } from '../../pty/windows-pane-agent-stop-rows'
import { paneAgentStopLineageRoot } from '../../pty/pane-agent-stop-release'
import { OrcaRuntimeWithGetWorktreePs } from '../workspaces/workspace-process-listing'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  captureWindowsPaneAgentStop,
  stopWindowsPaneAgentAndWait
} from '../../pty/windows-pane-agent-stop'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import type { CliWriterTerminal } from '../structured-agent-cli-writers'
import {
  capturePosixPaneAgent,
  posixPaneShell,
  readPosixPaneProcessRows,
  samePaneProcess
} from '../../pty/pane-agent-identity-posix'
import { stopPaneAgentAndWait } from '../../pty/pane-agent-stop'
import {
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import {
  adoptsCliConversations,
  chatAgentsShareConversations
} from '../../../shared/structured-agent-cli-conversation-adoption'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import type { TerminalAgentStopPreparation } from './terminal-agent-stop-for-chat'

export abstract class OrcaRuntimeWithTerminalAgentStopPreparation extends OrcaRuntimeWithGetWorktreePs {
  protected abstract cliWriterTerminal(coordinates: {
    paneKey: string
    worktreeId?: string
  }): CliWriterTerminal | null
  protected async prepareTerminalAgentStopForChat(
    input: {
      agent: StructuredAgentId
      providerSessionId: string
      cliSource: { workspaceId: string; paneKey: string }
    },
    readRow: () => AgentStatusIpcPayload | null,
    signal: AbortSignal
  ): Promise<TerminalAgentStopPreparation> {
    const source = input.cliSource
    const pane = this.cliWriterTerminal({
      paneKey: source.paneKey,
      worktreeId: source.workspaceId
    })?.pane
    const pty = pane && this.ptysById.get(pane.ptyId)
    const row = readRow()
    if (
      !pane ||
      !pty ||
      !row ||
      !adoptsCliConversations(row.agentType) ||
      !chatAgentsShareConversations(row.agentType, input.agent)
    ) {
      throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
    }
    const conversationCurrent = () => {
      const now = readRow()
      const link = pty.cliConversations?.byKey.get(`${row.agentType}\0${input.providerSessionId}`)
      return (
        !signal.aborted &&
        this.ptysById.get(pane.ptyId) === pty &&
        pty.incarnationId === pane.incarnationId &&
        this.cliWriterTerminal({ paneKey: source.paneKey, worktreeId: source.workspaceId })?.pane
          ?.identity === pane.identity &&
        pty.cliConversations?.incarnationId === pane.incarnationId &&
        !!link &&
        (!now ||
          (now.providerSession?.id === input.providerSessionId && now.agentType === row.agentType))
      )
    }
    if (row.providerSession?.id !== input.providerSessionId || !conversationCurrent()) {
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'conversationMoved'
      })
    }
    const observation = this.readHookCliWriterObservationFn?.(row)
    if (!observation || !observation.current() || observation.topology !== 'pane-owned') {
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'writerTopologyUnproven'
      })
    }
    const entry = (await this.ptyController?.listProcesses?.(LOCAL_EXECUTION_HOST_ID))?.find(
      (candidate) => candidate.id === pane.ptyId
    )
    if (
      !entry?.rootProcessId ||
      entry.incarnationId !== pane.incarnationId ||
      !conversationCurrent()
    ) {
      throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
    }
    try {
      if (process.platform === 'win32') {
        const request = {
          rootPid: entry.rootProcessId,
          agent: row.agentType,
          hookProcess: row.agentPresence?.process,
          ptyId: pane.ptyId,
          incarnationId: pane.incarnationId
        }
        const captured = await captureWindowsPaneAgentStop(request)
        if (!captured) {
          throw new Error('agent identity unavailable')
        }
        if (captured.refusal) {
          throw agentSessionRefusalError('agent_session_operation_invalid', {
            reason: captured.refusal
          })
        }
        const rows = windowsPaneAgentStopRows(await captured.deps.readRows())
        const stopRoot =
          captured.agent && paneAgentStopLineageRoot(rows, captured.shell.pid, captured.agent)
        const release = stopRoot
          ? prepareTerminalAgentStopRelease({
              pty,
              agent: row.agentType,
              providerSessionId: input.providerSessionId,
              current: conversationCurrent,
              rows,
              readRows: async () => windowsPaneAgentStopRows(await captured.deps.readRows()),
              root: captured.root,
              shell: captured.shell,
              stopRoot,
              observedAgent: row.agentPresence?.process ?? captured.agent!,
              platform: 'win32'
            })
          : { released: async () => false, commitRelease: () => {} }
        return {
          ...release,
          hasAgent: !!captured.agent,
          paused: false,
          current: conversationCurrent,
          beforeInterrupt: async () => {
            const fresh = await captureWindowsPaneAgentStop(request)
            if (
              !fresh?.agent ||
              fresh.refusal ||
              fresh.agent.pid !== captured.agent?.pid ||
              fresh.agent.startTime !== captured.agent.startTime ||
              !conversationCurrent()
            ) {
              throw new Error('agent not in front')
            }
          },
          stop: () => stopWindowsPaneAgentAndWait(captured, conversationCurrent)
        }
      }
      const rows = await readPosixPaneProcessRows()
      const captured = capturePosixPaneAgent(
        rows,
        entry.rootProcessId,
        row.agentType,
        row.agentPresence?.process
      )
      const shell = captured?.shell ?? posixPaneShell(rows, entry.rootProcessId)
      if (!shell?.startTime) {
        throw new Error('shell unavailable')
      }
      const current = conversationCurrent
      const root = rows.find((item) => item.pid === entry.rootProcessId)
      if (!root?.startTime) {
        throw new Error('root identity unavailable')
      }
      const stopRoot = captured && paneAgentStopLineageRoot(rows, shell.pid, captured.agent)
      const release = stopRoot
        ? prepareTerminalAgentStopRelease({
            pty,
            agent: row.agentType,
            providerSessionId: input.providerSessionId,
            current,
            rows,
            readRows: readPosixPaneProcessRows,
            root: { pid: root.pid, startTime: root.startTime },
            shell: { pid: shell.pid, startTime: shell.startTime },
            stopRoot,
            observedAgent: row.agentPresence?.process ?? captured!.agent,
            platform: 'posix'
          })
        : { released: async () => false, commitRelease: () => {} }
      return {
        ...release,
        hasAgent: !!captured,
        paused: captured?.paused ?? false,
        current: conversationCurrent,
        beforeInterrupt: async () => {
          const fresh = await readPosixPaneProcessRows()
          const agent = captured && fresh.find((item) => item.pid === captured.agent.pid)
          if (
            !captured ||
            !samePaneProcess(agent || undefined, captured.agent) ||
            agent?.tpgid !== captured.agentPgid ||
            !current()
          ) {
            throw new Error('agent not in front')
          }
        },
        stop: () =>
          captured
            ? stopPaneAgentAndWait(captured, {
                readRows: readPosixPaneProcessRows,
                ownsPane: current,
                signal: (target, signal) => {
                  process.kill(target.pid, signal)
                }
              })
            : Promise.resolve('exited')
      }
    } catch (error) {
      if (isAgentSessionRefusalError(error)) {
        throw error
      }
      throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
    }
  }
}
