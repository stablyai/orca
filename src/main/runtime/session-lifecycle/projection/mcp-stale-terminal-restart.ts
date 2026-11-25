import { access } from 'node:fs/promises'
import { OrcaRuntimeWithClaudeRunningPaneAccountMove } from './claude-running-pane-account-move'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-status/process/agent-process-recognition'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import { terminalMcpPanes } from '../../../mcp-servers/terminal/terminal-mcp-panes'
import { currentTerminalMcpFingerprints } from '../../../mcp-servers/terminal/terminal-mcp-launch'
import type { TerminalMcpPaneLaunch } from '../../../mcp-servers/terminal/terminal-mcp-launch'

type StaleTerminal = {
  pty: RuntimePtyWorktreeRecord
  pane: TerminalMcpPaneLaunch
  /** Its agent's conversation, which a restart resumes; null when none is known. */
  session: { agent: TuiAgent; providerSession: AgentProviderSessionMetadata } | null
}

// Each restart stops one terminal and starts its replacement; a few at a time keeps the host responsive.
const RESTARTS_AT_ONCE = 3

/** This host's own agent terminals still on an older MCP server list than the host's now, and
 *  restarting them in place, their conversation resumed. Chats pick a change up on their next turn. */
export abstract class OrcaRuntimeWithMcpStaleTerminals extends OrcaRuntimeWithClaudeRunningPaneAccountMove {
  private async staleMcpTerminals(): Promise<StaleTerminal[]> {
    const live: { pty: RuntimePtyWorktreeRecord; pane: TerminalMcpPaneLaunch }[] = []
    for (const [ptyId, pane] of await terminalMcpPanes.all()) {
      const pty = this.ptysById.get(ptyId)
      if (
        pty?.connected &&
        pty.connectionId === null &&
        !isRemoteRuntimePtyId(ptyId) &&
        pane.fingerprint !== null &&
        // Its agent exited to the shell: nothing there uses the servers any more.
        pty.launchEvidence?.kind !== 'gone'
      ) {
        live.push({ pty, pane })
      }
    }
    // A pane's workspace and agent decide which servers it would get now.
    const current = await currentTerminalMcpFingerprints(live.map(({ pane }) => pane))
    const stale: StaleTerminal[] = []
    for (const { pty, pane } of live) {
      const now = current.get(pane) ?? null
      if (now === null || now === pane.fingerprint) {
        continue
      }
      // After a main restart its launch evidence is unknown: only its foreground says the agent runs.
      const running = await this.mcpTerminalAgentRunning(pty)
      if (running !== false) {
        stale.push({
          pty,
          pane,
          session: running === true ? await this.mcpTerminalSession(pty) : null
        })
      }
    }
    return stale
  }

  /** Whether the pane's foreground process is the agent it launched; unchecked when unreadable. */
  private async mcpTerminalAgentRunning(
    pty: RuntimePtyWorktreeRecord
  ): Promise<boolean | 'unchecked'> {
    const controller = this.ptyController
    if (!controller || !pty.launchAgent) {
      return 'unchecked'
    }
    const name = await controller.getForegroundProcess(pty.ptyId).catch(() => null)
    const fresh =
      name === null || isAgentForegroundWrapperProcess(name)
        ? ((await controller.confirmForegroundProcess?.(pty.ptyId).catch(() => null)) ?? name)
        : name
    if (fresh === null) {
      return 'unchecked'
    }
    return recognizeAgentProcess(fresh)?.agent === pty.launchAgent
  }

  private async mcpTerminalSession(
    pty: RuntimePtyWorktreeRecord
  ): Promise<StaleTerminal['session']> {
    const agent = pty.launchAgent
    const recorded = this.paneOfPty(pty).paneKey
    if (!agent || !isResumableTuiAgent(agent) || !recorded) {
      return null
    }
    const row = this.getAgentStatusRowsForPane(recorded).find(
      (candidate) => candidate.agentType === agent
    )
    const saved = this.getWorkspaceSessionForWorktree(pty.worktreeId)
      ?.sleepingAgentSessionsByPaneKey?.[recorded]
    const providerSession =
      normalizeAgentProviderSession(row?.providerSession) ??
      normalizeAgentProviderSession(saved?.agent === agent ? saved.providerSession : undefined)
    if (!providerSession) {
      return null
    }
    // A conversation with no message yet has no transcript, and a resume of it finds nothing.
    const { transcriptPath } = providerSession
    if (
      transcriptPath &&
      !(await access(transcriptPath).then(
        () => true,
        () => false
      ))
    ) {
      return null
    }
    return { agent, providerSession }
  }

  /** mcpServers.sessions.stale: how many terminals still use an older list, and how many of
   *  those Orca can restart in place. */
  async countMcpStaleTerminals(): Promise<{ count: number; restartable: number }> {
    const stale = await this.staleMcpTerminals()
    return { count: stale.length, restartable: stale.filter((entry) => entry.session).length }
  }

  /** mcpServers.sessions.restart: restarts every stale terminal whose conversation it can resume;
   *  the rest, and any whose restart was refused, are skipped. */
  async restartMcpStaleTerminals(): Promise<{ restarted: number; skipped: number }> {
    const stale = await this.staleMcpTerminals()
    const queue = stale.filter((entry) => entry.session)
    let restarted = 0
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { pty, pane, session } = next
        // Last before the stop: earlier restarts take seconds, in which this pane's agent can exit
        // or move to another conversation, and the list can change back.
        const result = await this.restartAgentPaneInPlace(pty.ptyId, session!, async () => {
          const current = this.ptysById.get(pty.ptyId)
          if (
            !current?.connected ||
            current.launchEvidence?.kind === 'gone' ||
            (await this.mcpTerminalAgentRunning(current)) !== true
          ) {
            return false
          }
          const live = await this.mcpTerminalSession(current)
          // An unreadable list gives no replacement config, so the agent keeps running as it is.
          const now = (await currentTerminalMcpFingerprints([pane])).get(pane) ?? null
          return (
            live?.providerSession.id === session!.providerSession.id &&
            now !== null &&
            now !== pane.fingerprint
          )
        })
        if (result.ok) {
          restarted += 1
        } else {
          console.warn('[mcp-servers] a terminal on an older server list did not restart', {
            ptyId: pty.ptyId,
            reason: result.reason
          })
        }
      }
    }
    await Promise.all(Array.from({ length: RESTARTS_AT_ONCE }, worker))
    return { restarted, skipped: stale.length - restarted }
  }
}
