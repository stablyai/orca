// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSplitPtyBackedTerminal } from './orca-runtime-split-pty-backed-terminal'
import {
  resolveTerminalSessionWorktreeId,
  runtimeWorktreeIdsEqual
} from './runtime-worktree-path-identity'
import { makePaneKey } from '../../shared/stable-pane-id'
import { terminalLayoutContainsLeaf } from './headless-terminal-split-layout'
import type {
  AgentTeamsTmuxCompatRequest,
  AgentTeamsTmuxCompatResponse
} from './claude-agent-teams-service'
import {
  resolveClaudeAgentTeamsNativeShim,
  type ClaudeAgentTeamsLaunchPlan
} from './claude-agent-teams-shim-env'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'

export class OrcaRuntimeWithResolveTerminalSplitSourceAuthority extends OrcaRuntimeWithSplitPtyBackedTerminal {
  protected resolveTerminalSplitSourceAuthority(
    worktreeId: string,
    tabId: string,
    leafId: string,
    ptyId: string
  ): {
    persisted: boolean
    rendererMounted: boolean
    persistedWorktreeId: string | null
    persistedIncarnationId: string | null
    liveIncarnationId: string | null
  } | null {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const sessionWorktreeId = session ? resolveTerminalSessionWorktreeId(session, worktreeId) : null
    const persistedTab = sessionWorktreeId
      ? session?.tabsByWorktree[sessionWorktreeId]?.find(
          (tab) => tab.id === tabId && runtimeWorktreeIdsEqual(tab.worktreeId, worktreeId)
        )
      : undefined
    const persistedLayout = session?.terminalLayoutsByTabId?.[tabId]
    const persistedIncarnationId =
      session?.terminalPtyIncarnationsByPaneKey?.[makePaneKey(tabId, leafId)] ?? null
    const liveIncarnationId = this.ptysById.get(ptyId)?.incarnationId ?? null
    if (
      persistedIncarnationId &&
      liveIncarnationId &&
      persistedIncarnationId !== liveIncarnationId
    ) {
      return null
    }
    const persisted = Boolean(
      persistedTab &&
      persistedLayout?.ptyIdsByLeafId?.[leafId] === ptyId &&
      terminalLayoutContainsLeaf(persistedLayout.root, leafId)
    )
    const rendererTab = this.tabs.get(tabId)
    const rendererLeaf = this.leaves.get(this.getLeafKey(tabId, leafId))
    const rendererMounted = Boolean(
      rendererTab &&
      rendererLeaf &&
      runtimeWorktreeIdsEqual(rendererTab.worktreeId, worktreeId) &&
      runtimeWorktreeIdsEqual(rendererLeaf.worktreeId, worktreeId) &&
      rendererLeaf.ptyId === ptyId
    )
    if (persisted && persistedLayout) {
      return {
        persisted: true,
        rendererMounted,
        persistedWorktreeId: sessionWorktreeId,
        persistedIncarnationId,
        liveIncarnationId
      }
    }
    // Why: renderer adoption can precede graph sync; this path still requires reveal success before commit.
    const projected = [...this.mobileSessionTabsByWorktree.entries()].some(
      ([candidateWorktreeId, snapshot]) =>
        runtimeWorktreeIdsEqual(candidateWorktreeId, worktreeId) &&
        snapshot.tabs.some(
          (tab) =>
            tab.type === 'terminal' &&
            tab.parentTabId === tabId &&
            tab.leafId === leafId &&
            (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[leafId] === ptyId)
        )
    )
    if (!rendererMounted && !projected) {
      return null
    }
    return {
      persisted: false,
      rendererMounted,
      persistedWorktreeId: null,
      persistedIncarnationId: null,
      liveIncarnationId
    }
  }

  async handleAgentTeamsTmuxCompat(
    request: AgentTeamsTmuxCompatRequest
  ): Promise<AgentTeamsTmuxCompatResponse> {
    return await this.claudeAgentTeams.handleTmuxCompat(request, {
      splitTerminal: (handle, opts) => this.splitTerminal(handle, opts),
      readTerminal: (handle, opts) => this.readTerminal(handle, opts),
      sendTerminal: (handle, action) => this.sendTerminal(handle, action),
      focusTerminal: (handle) => this.focusTerminal(handle),
      closeTerminal: (handle) => this.closeAgentTeamsPaneTerminal(handle),
      showTerminal: (handle) => this.showTerminal(handle)
    })
  }

  // Why: respawn-pane closes a teammate's placeholder terminal, then immediately
  // re-splits from its origin pane. closeTerminal() confirms the PTY *process*
  // died, but for a multi-pane tab it deliberately skips telling the renderer to
  // remove the pane's tile (see orca-runtime-stop-explicitly-closed-tab-ptys.ts,
  // "renderer's exit handler closes the pane"). That assumption doesn't hold: a
  // PTY dying only makes the renderer show a "terminal exited" banner on the
  // still-mounted pane (handlePaneProcessDied) — nothing calls PaneManager's
  // closePane() to actually remove it. Only an explicit close IPC does that. So
  // this agent-teams-only close explicitly requests removal, then waits for the
  // renderer to confirm it before the follow-up split proceeds, closing the
  // ghost-pane race without changing closeTerminal()'s behavior for any other caller.
  private async closeAgentTeamsPaneTerminal(handle: string) {
    let leafCoords: { tabId: string; leafId: string; paneRuntimeId: number } | null = null
    try {
      const { leaf } = this.getLiveLeafForHandle(handle)
      leafCoords = { tabId: leaf.tabId, leafId: leaf.leafId, paneRuntimeId: leaf.paneRuntimeId }
    } catch {
      leafCoords = null
    }
    const close = await this.closeTerminal(handle)
    if (close.ptyKilled && leafCoords && this.notifier) {
      this.notifier.closeTerminal(leafCoords.tabId, leafCoords.paneRuntimeId)
      await this.waitForLeafGoneFromTab(leafCoords.tabId, leafCoords.leafId)
    }
    return close
  }

  private waitForLeafGoneFromTab(tabId: string, leafId: string, timeoutMs = 10_000): Promise<void> {
    const leafKey = this.getLeafKey(tabId, leafId)
    if (!this.leaves.has(leafKey)) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
      }
      const check = (): void => {
        if (!this.leaves.has(leafKey)) {
          cleanup()
          resolve()
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for pane to leave the layout'))
      }, timeoutMs)
      this.graphSyncCallbacks.push(check)
      check()
    })
  }

  async prepareClaudeAgentTeamsLeader(args: {
    paneKey: string
    baseEnv?: Record<string, string>
    prepareAuth?: boolean
  }): Promise<{ env: Record<string, string> }> {
    const handle = this.getTerminalHandleForPaneKey(args.paneKey)
    if (!handle) {
      throw new Error('claude_agent_teams_requires_orca_terminal')
    }
    return await this.prepareClaudeAgentTeamsLeaderForHandle({
      handle,
      baseEnv: args.baseEnv,
      prepareAuth: args.prepareAuth
    })
  }

  async prepareClaudeAgentTeamsLeaderForHandle(args: {
    handle: string
    baseEnv?: Record<string, string>
    prepareAuth?: boolean
  }): Promise<{
    env: Record<string, string>
    envToDelete?: string[]
    mode: ClaudeAgentTeamsLaunchPlan['mode']
  }> {
    const baseEnv = {
      ...process.env,
      ...args.baseEnv
    }
    const inheritedEnvKeys = new Set(Object.keys(baseEnv))
    const auth = args.prepareAuth && this.prepareClaudeAuth ? await this.prepareClaudeAuth() : null
    if (auth) {
      applyClaudeEnvPatch(baseEnv, auth.envPatch, { stripAuthEnv: auth.stripAuthEnv })
    }
    const envToDelete = auth?.stripAuthEnv
      ? [...inheritedEnvKeys].filter((key) => !(key in baseEnv))
      : undefined
    // Why: teammate panes launch on the local host, so the local Windows shell preference decides their grammar.
    const paneShell = resolveLocalWindowsAgentStartupShell({
      platform: process.platform,
      isRemote: false,
      terminalWindowsShell: this.store?.getSettings?.().terminalWindowsShell ?? null
    })
    const shim = await resolveClaudeAgentTeamsNativeShim({ baseEnv, paneShell })
    const mode = shim ? 'native-panes-shim' : 'in-process'
    const launchEnv = shim
      ? this.claudeAgentTeams.createLaunchEnv({
          leaderHandle: args.handle,
          baseEnv,
          shimDir: shim.shimDir,
          shimBin: shim.shimBin,
          paneShell
        }).env
      : { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
    const env = auth ? { ...auth.envPatch, ...launchEnv } : launchEnv
    return envToDelete ? { env, envToDelete, mode } : { env, mode }
  }

  // Why: a leader handle that never binds to a PTY (lost pane race) has no exit
  // or close path to evict its team, so the abandoning caller must release it.
  releaseClaudeAgentTeamsLeaderForHandle(handle: string): void {
    this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
  }

  protected waitForLeafInTab(tabId: string, leafId: string, timeoutMs = 10_000): Promise<string> {
    const tryResolve = (): string | null => {
      const leaf = this.leaves.get(this.getLeafKey(tabId, leafId))
      return leaf?.ptyId !== null && leaf?.ptyId !== undefined ? this.issueHandle(leaf) : null
    }

    const existing = tryResolve()
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        reject(new Error('Timed out waiting for split pane handle'))
      }, timeoutMs)

      const check = (): void => {
        const handle = tryResolve()
        if (handle) {
          clearTimeout(timer)
          const idx = this.graphSyncCallbacks.indexOf(check)
          if (idx !== -1) {
            this.graphSyncCallbacks.splice(idx, 1)
          }
          resolve(handle)
        }
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }
}
