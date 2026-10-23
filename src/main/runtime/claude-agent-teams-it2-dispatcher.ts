import {
  fakePaneIdForIt2Session,
  it2SessionIdForPane,
  type It2Command
} from '../../shared/claude-agent-teams-it2-compat'
import { describeUnconfirmedAgentStop } from '../../shared/pty-liveness-verdict'
import { paneEnv, removePane } from './claude-agent-teams-pane-layout'
import type { AgentTeam, AgentTeamsTerminalApi, TeamPane } from './claude-agent-teams-types'

export class ClaudeAgentTeamsIt2Dispatcher {
  async dispatch(
    team: AgentTeam,
    command: It2Command,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    switch (command.kind) {
      case 'list':
        return team.paneOrder.map((paneId) => `${it2SessionIdForPane(paneId)}\n`).join('')
      case 'split':
        return await this.split(team, command, api)
      case 'send':
        await this.write(this.resolvePane(team, command.sessionId), { text: command.text }, api)
        return ''
      case 'run':
        if (!command.command) {
          throw new Error('run requires a command')
        }
        await this.write(
          this.resolvePane(team, command.sessionId),
          { text: command.command, enter: true },
          api
        )
        return ''
      case 'close':
        return await this.close(team, command, api)
    }
  }

  private async split(
    team: AgentTeam,
    command: Extract<It2Command, { kind: 'split' }>,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const target = this.resolvePane(team, command.sessionId)
    const fakePaneId = `%${team.nextPaneNumber}`
    team.nextPaneNumber += 1
    // Why: it2 `-v` makes a vertical divider (side-by-side panes), which Orca names 'vertical'.
    const direction = command.vertical ? 'vertical' : 'horizontal'
    let split: Awaited<ReturnType<AgentTeamsTerminalApi['splitTerminal']>>
    try {
      // Why: Claude types the teammate command into the new session afterwards, so the pane starts as a bare shell.
      split = await api.splitTerminal(target.handle, {
        direction,
        env: paneEnv(team, fakePaneId),
        envToDelete: ['TERM_PROGRAM'],
        activate: false
      })
    } catch (error) {
      // Why: Claude retries from another session only once `session list` stops showing the failed split target.
      if (target.fakePaneId !== team.leaderPane) {
        removePane(team, target)
      }
      throw error
    }
    team.panes.set(fakePaneId, {
      fakePaneId,
      handle: split.handle,
      index: team.paneOrder.length,
      splitFromPane: target.fakePaneId,
      splitDirection: direction
    })
    team.paneOrder.push(fakePaneId)
    return `Created new pane: ${it2SessionIdForPane(fakePaneId)}\n`
  }

  // Why: Claude only checks the exit code, so a refused write must fail instead of looking like a typed command.
  private async write(
    pane: TeamPane,
    action: { text: string; enter?: boolean },
    api: AgentTeamsTerminalApi
  ): Promise<void> {
    if (!action.text) {
      return
    }
    const sent = await api.sendTerminal(pane.handle, action, { inputKind: 'driving' })
    if (!sent.accepted) {
      throw new Error(`terminal did not accept input for ${it2SessionIdForPane(pane.fakePaneId)}`)
    }
  }

  private async close(
    team: AgentTeam,
    command: Extract<It2Command, { kind: 'close' }>,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    if (!command.sessionId) {
      throw new Error('close requires -s <session>')
    }
    const pane = this.resolvePane(team, command.sessionId)
    if (pane.fakePaneId === team.leaderPane) {
      throw new Error('refusing to close leader session')
    }
    const close = await api.closeTerminal(pane.handle)
    if (!close.ptyKilled) {
      throw new Error(describeUnconfirmedAgentStop(close))
    }
    removePane(team, pane)
    return ''
  }

  private resolvePane(team: AgentTeam, sessionId: string | undefined): TeamPane {
    const fakePaneId =
      sessionId === undefined ? team.leaderPane : fakePaneIdForIt2Session(sessionId)
    const pane = fakePaneId ? team.panes.get(fakePaneId) : undefined
    if (!pane) {
      throw new Error(`unknown session: ${sessionId ?? it2SessionIdForPane(team.leaderPane)}`)
    }
    return pane
  }
}
