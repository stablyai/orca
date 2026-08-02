import {
  parseTmuxArgs,
  renderTmuxFormat,
  tmuxSendKeysText,
  tmuxValue
} from '../../shared/claude-agent-teams-tmux-compat'
import {
  formatContext,
  paneEnv,
  resolveSplitTarget,
  updateMainVerticalAfterSplit
} from './claude-agent-teams-pane-layout'
import type { AgentTeam, AgentTeamsTerminalApi, TeamPane } from './claude-agent-teams-types'

type ResolvedTarget = { type: 'pane'; pane: TeamPane } | { type: 'window' }

export class ClaudeAgentTeamsTmuxDispatcher {
  async dispatch(
    team: AgentTeam,
    command: string,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    switch (command) {
      case '-V':
      case '-v':
        return 'tmux 3.4\n'
      case 'show-options':
      case 'show-option':
      case 'show':
        return this.showOptions(args)
      case 'display-message':
      case 'display':
      case 'displayp':
        return this.displayMessage(team, args, envPane)
      case 'split-window':
      case 'splitw':
        return await this.splitWindow(team, args, envPane, api)
      case 'respawn-pane':
      case 'respawnp':
        return await this.respawnPane(team, args, envPane, api)
      case 'select-layout':
        return this.selectLayout(team, args, envPane)
      case 'resize-pane':
      case 'resizep':
        return ''
      case 'list-panes':
      case 'lsp':
        return this.listPanes(team, args, envPane)
      case 'send-keys':
      case 'send':
        return await this.sendKeys(team, args, envPane, api)
      case 'capture-pane':
      case 'capturep':
        return await this.capturePane(team, args, envPane, api)
      case 'select-pane':
      case 'selectp':
        return await this.selectPane(team, args, envPane, api)
      case 'kill-pane':
      case 'killp':
        return await this.killPane(team, args, envPane, api)
      case 'last-pane':
        return await this.lastPane(team, args, api)
      case 'set-option':
      case 'set':
      case 'set-window-option':
      case 'setw':
      case 'set-hook':
      case 'refresh-client':
      case 'attach-session':
      case 'detach-client':
      case 'source-file':
      case 'wait-for':
      case 'has-session':
      case 'has':
        return ''
      default:
        throw new Error(`unsupported command: ${command}`)
    }
  }

  private showOptions(args: string[]): string {
    const parsed = parseTmuxArgs(args, ['-t'], ['-g', '-q', '-s', '-v', '-w'])
    const optionName = parsed.positional.at(-1) ?? ''
    if (optionName !== 'extended-keys') {
      throw new Error(`unsupported option: ${optionName}`)
    }
    return parsed.flags.has('-v') ? 'on\n' : 'extended-keys on\n'
  }

  private displayMessage(team: AgentTeam, args: string[], envPane: string): string {
    const parsed = parseTmuxArgs(args, ['-F', '-t'], ['-p'])
    const target = this.resolvePaneOrWindow(team, tmuxValue(parsed, '-t') ?? envPane)
    const pane = target.type === 'window' ? this.resolvePane(team, envPane) : target.pane
    const format =
      parsed.positional.length > 0 ? parsed.positional.join(' ') : tmuxValue(parsed, '-F')
    return `${renderTmuxFormat(format, formatContext(team, pane), '')}\n`
  }

  private async splitWindow(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseTmuxArgs(
      args,
      ['-c', '-F', '-l', '-t'],
      ['-P', '-b', '-d', '-f', '-h', '-v']
    )
    const targetPane = this.resolvePane(team, tmuxValue(parsed, '-t') ?? envPane)
    const fakePaneId = `%${team.nextPaneNumber}`
    team.nextPaneNumber += 1
    const splitTarget = resolveSplitTarget(team, targetPane, parsed.flags.has('-h'))
    const split = await api.splitTerminal(splitTarget.pane.handle, {
      direction: splitTarget.direction,
      command: parsed.positional.join(' ') || undefined,
      env: paneEnv(team, fakePaneId),
      envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR'],
      activate: false
    })
    const pane: TeamPane = {
      fakePaneId,
      handle: split.handle,
      index: team.paneOrder.length,
      splitFromPane: splitTarget.pane.fakePaneId,
      splitDirection: splitTarget.direction
    }
    team.panes.set(fakePaneId, pane)
    team.paneOrder.push(fakePaneId)
    updateMainVerticalAfterSplit(team, fakePaneId, splitTarget)
    if (!parsed.flags.has('-P')) {
      return ''
    }
    return `${renderTmuxFormat(tmuxValue(parsed, '-F'), formatContext(team, pane), fakePaneId)}\n`
  }

  // Why: Claude Code's pane backend creates a teammate pane in two steps — it
  // splits a holding pane running `cat`, then `respawn-pane -k`s it with the
  // real teammate command. Orca panes are PTYs that cannot swap their program in
  // place, so we honor respawn by closing the placeholder terminal and
  // re-splitting from the same origin with the real command, keeping the fake
  // pane id stable so later send-keys/kill-pane/list-panes still resolve.
  private async respawnPane(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseTmuxArgs(args, ['-c', '-e', '-t'], ['-k'])
    const pane = this.resolvePane(team, tmuxValue(parsed, '-t') ?? envPane)
    if (pane.fakePaneId === team.leaderPane) {
      throw new Error('refusing to respawn leader pane')
    }
    const command = parsed.positional.join(' ')
    if (!command) {
      return ''
    }
    const origin =
      (pane.splitFromPane ? team.panes.get(pane.splitFromPane) : undefined) ??
      team.panes.get(team.leaderPane)!
    // Why: create the replacement before destroying the placeholder so a failed
    // split leaves the fake pane id pointing at a still-live terminal; on cleanup
    // failure, discard the new split and keep the placeholder registered.
    const previousHandle = pane.handle
    const split = await api.splitTerminal(origin.handle, {
      direction: pane.splitDirection ?? 'horizontal',
      command,
      env: paneEnv(team, pane.fakePaneId),
      envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR'],
      activate: false
    })
    try {
      await api.closeTerminal(previousHandle)
    } catch (error) {
      await api.closeTerminal(split.handle).catch(() => {})
      throw error
    }
    pane.handle = split.handle
    return ''
  }

  private selectLayout(team: AgentTeam, args: string[], envPane: string): string {
    const parsed = parseTmuxArgs(args, ['-t'], [])
    const layout = parsed.positional[0] ?? ''
    if (layout === 'main-vertical') {
      const target = this.resolvePaneOrWindow(team, tmuxValue(parsed, '-t') ?? envPane)
      const targetPane = target.type === 'pane' ? target.pane : null
      team.mainVertical = {
        mainPane: team.leaderPane,
        lastColumnPane:
          team.mainVertical?.lastColumnPane ??
          (targetPane && targetPane.fakePaneId !== team.leaderPane ? targetPane.fakePaneId : null)
      }
    } else if (layout) {
      team.mainVertical = null
    }
    return ''
  }

  private listPanes(team: AgentTeam, args: string[], envPane: string): string {
    const parsed = parseTmuxArgs(args, ['-F', '-t'], [])
    this.resolvePaneOrWindow(team, tmuxValue(parsed, '-t') ?? envPane)
    return team.paneOrder
      .map((paneId) => {
        const pane = team.panes.get(paneId)!
        return renderTmuxFormat(tmuxValue(parsed, '-F'), formatContext(team, pane), pane.fakePaneId)
      })
      .join('\n')
      .concat('\n')
  }

  private async sendKeys(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseTmuxArgs(args, ['-t'], ['-l'])
    const pane = this.resolvePane(team, tmuxValue(parsed, '-t') ?? envPane)
    const text = tmuxSendKeysText(parsed.positional, parsed.flags.has('-l'))
    if (text) {
      await api.sendTerminal(pane.handle, { text })
    }
    return ''
  }

  private async capturePane(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseTmuxArgs(args, ['-E', '-S', '-t'], ['-J', '-N', '-p'])
    const pane = this.resolvePane(team, tmuxValue(parsed, '-t') ?? envPane)
    const read = await api.readTerminal(pane.handle, { limit: 1000 })
    const text = read.tail.join('\n')
    return parsed.flags.has('-p') ? `${text}\n` : ''
  }

  private async selectPane(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseTmuxArgs(args, ['-P', '-T', '-t'], [])
    if (tmuxValue(parsed, '-P') || tmuxValue(parsed, '-T')) {
      return ''
    }
    const pane = this.resolvePane(team, tmuxValue(parsed, '-t') ?? envPane)
    team.previouslyFocusedPane = envPane
    await api.focusTerminal(pane.handle)
    return ''
  }

  private async killPane(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseTmuxArgs(args, ['-t'], [])
    const pane = this.resolvePane(team, tmuxValue(parsed, '-t') ?? envPane)
    if (pane.fakePaneId === team.leaderPane) {
      throw new Error('refusing to kill leader pane')
    }
    await api.closeTerminal(pane.handle)
    team.panes.delete(pane.fakePaneId)
    team.paneOrder = team.paneOrder.filter((id) => id !== pane.fakePaneId)
    if (team.mainVertical?.lastColumnPane === pane.fakePaneId) {
      team.mainVertical.lastColumnPane =
        [...team.paneOrder].toReversed().find((id) => id !== team.leaderPane) ?? null
    }
    return ''
  }

  private async lastPane(
    team: AgentTeam,
    args: string[],
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    parseTmuxArgs(args, ['-t'], [])
    const pane = team.previouslyFocusedPane ? team.panes.get(team.previouslyFocusedPane) : null
    if (pane) {
      await api.focusTerminal(pane.handle)
    }
    return ''
  }

  private resolvePaneOrWindow(team: AgentTeam, target: string): ResolvedTarget {
    if (target.includes(':') || target === team.sessionName || target.startsWith('@')) {
      return { type: 'window' }
    }
    return { type: 'pane', pane: this.resolvePane(team, target) }
  }

  private resolvePane(team: AgentTeam, target: string): TeamPane {
    const pane = team.panes.get(target)
    if (!pane) {
      throw new Error(`unknown pane: ${target}`)
    }
    return pane
  }
}
