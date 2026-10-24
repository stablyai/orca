import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import { OrcaRuntimeWithSplitPaneInMain } from './terminal-split-in-main'
import { resolveTerminalSessionWorktreeId } from '../../runtime-worktree-path-identity'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { terminalLayoutContainsLeaf } from '../../../../shared/workspace-session-pane-ownership'
import type {
  AgentTeamsTmuxCompatRequest,
  AgentTeamsTmuxCompatResponse
} from '../../claude-agent-teams-types'
import {
  ensureClaudeAgentTeamsShimDir,
  resolveClaudeAgentTeamsShimBin
} from '../../claude-agent-teams-shim-env'
import { applyClaudeEnvPatch } from '../../../claude-accounts/environment'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { splitPanePendingError } from './terminal-split-retry'
import {
  SPLIT_PANE_APPEAR_TIMEOUT_MS,
  SPLIT_PANE_START_TIMEOUT_MS
} from './terminal-split-wait-timeout'

export abstract class OrcaRuntimeWithResolveTerminalSplitSourceAuthority extends OrcaRuntimeWithSplitPaneInMain {
  abstract getTerminalHandleForPaneKey(
    ...args: Parameters<
      OrcaRuntimeWithPruneMobileSessionTabGroupLayout['getTerminalHandleForPaneKey']
    >
  ): ReturnType<OrcaRuntimeWithPruneMobileSessionTabGroupLayout['getTerminalHandleForPaneKey']>

  protected resolveTerminalSplitSourceAuthority(
    worktreeId: string,
    tabId: string,
    leafId: string,
    ptyId: string
  ):
    | {
        persisted: true
        rendererRunsOtherPty: boolean
        persistedWorktreeId: string | null
        persistedIncarnationId: string | null
        liveIncarnationId: string | null
      }
    | {
        persisted: false
        persistedWorktreeId: null
        persistedIncarnationId: null
        liveIncarnationId: string | null
      }
    | null {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const sessionWorktreeId = session ? resolveTerminalSessionWorktreeId(session, worktreeId) : null
    const persistedTab = sessionWorktreeId
      ? session?.tabsByWorktree[sessionWorktreeId]?.find(
          (tab) => tab.id === tabId && worktreeIdsEqual(tab.worktreeId, worktreeId)
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
    // A mounted pane can publish before its PTY binds; persisted identity fences that gap.
    const rendererMounted = Boolean(
      rendererTab &&
      rendererLeaf &&
      worktreeIdsEqual(rendererTab.worktreeId, worktreeId) &&
      worktreeIdsEqual(rendererLeaf.worktreeId, worktreeId) &&
      (rendererLeaf.ptyId === ptyId || (persisted && rendererLeaf.ptyId === null))
    )
    // Only a contradiction is trusted: the window's graph lags, so an unlisted pane proves nothing.
    const rendererRunsOtherPty = Boolean(rendererLeaf?.ptyId && rendererLeaf.ptyId !== ptyId)
    if (persisted && persistedLayout) {
      return {
        persisted: true,
        rendererRunsOtherPty,
        persistedWorktreeId: sessionWorktreeId,
        persistedIncarnationId,
        liveIncarnationId
      }
    }
    // Why: renderer adoption can precede graph sync; this path still requires reveal success before commit.
    const projected = [...this.mobileSessionTabsByWorktree.entries()].some(
      ([candidateWorktreeId, snapshot]) =>
        worktreeIdsEqual(candidateWorktreeId, worktreeId) &&
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
      sendTerminal: (handle, action, options) => this.sendTerminal(handle, action, options),
      focusTerminal: (handle) => this.focusTerminal(handle),
      closeTerminal: (handle) => this.closeTerminal(handle),
      showTerminal: (handle) => this.showTerminal(handle)
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
  }): Promise<{ env: Record<string, string>; envToDelete?: string[] }> {
    const baseEnv = {
      ...process.env,
      ...args.baseEnv
    }
    const auth = args.prepareAuth && this.prepareClaudeAuth ? await this.prepareClaudeAuth() : null
    if (auth) {
      applyClaudeEnvPatch(baseEnv, auth.envPatch)
    }
    const shimDir = await ensureClaudeAgentTeamsShimDir()
    const shimBin = resolveClaudeAgentTeamsShimBin(baseEnv)
    const launch = this.claudeAgentTeams.createLaunchEnv({
      leaderHandle: args.handle,
      baseEnv,
      shimDir,
      shimBin
    })
    const env = auth ? { ...auth.envPatch, ...launch.env } : launch.env
    return { env }
  }

  // Why: a leader handle that never binds to a PTY (lost pane race) has no exit
  // or close path to evict its team, so the abandoning caller must release it.
  releaseClaudeAgentTeamsLeaderForHandle(handle: string): void {
    this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
  }

  /**
   * Resolves once the window binds the new pane's terminal. The first deadline is for the pane to
   * appear; a pane that appeared is starting, so it gets the longer one before main gives up.
   */
  protected waitForLeafInTab(
    tabId: string,
    leafId: string,
    timeouts: { appearMs?: number; startMs?: number } = {}
  ): Promise<string> {
    const appearMs = timeouts.appearMs ?? SPLIT_PANE_APPEAR_TIMEOUT_MS
    const startMs = Math.max(appearMs, timeouts.startMs ?? SPLIT_PANE_START_TIMEOUT_MS)
    const listedLeaf = () => this.leaves.get(this.getLeafKey(tabId, leafId))
    const tryResolve = (): string | null => {
      const leaf = listedLeaf()
      return leaf?.ptyId !== null && leaf?.ptyId !== undefined ? this.issueHandle(leaf) : null
    }

    const existing = tryResolve()
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<string>((resolve, reject) => {
      const stopWatching = (): void => {
        clearTimeout(timer)
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
      }
      // Absence never proves a close: an unbound pane leaves the graph while it remounts.
      const giveUp = (): void => {
        stopWatching()
        reject(splitPanePendingError(tabId, leafId))
      }
      let timer = setTimeout(() => {
        if (listedLeaf()) {
          timer = setTimeout(giveUp, startMs - appearMs)
        } else {
          giveUp()
        }
      }, appearMs)

      const check = (): void => {
        const handle = tryResolve()
        if (handle) {
          stopWatching()
          resolve(handle)
        }
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }
}
