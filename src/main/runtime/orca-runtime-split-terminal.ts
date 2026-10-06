// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from './orca-runtime-stop-explicitly-closed-tab-ptys'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import type { Worktree } from '../../shared/worktree/types'
import type { BrowserWindow } from 'electron'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { parseExactWorktreeIdSelector } from './runtime-worktree-selection'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost
} from '../../shared/folder-workspace-execution-host'
import { makePaneKey } from '../../shared/stable-pane-id'
import { withTimeout } from './runtime-async-boundaries'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from './orca-runtime-core'

type LocalDesktopSplitSource = {
  window: BrowserWindow
  epoch: number
  worktreeId: string
  tabId: string | null
  paneKey: string | null
  incarnationId: RuntimePtyWorktreeRecord['incarnationId']
}

export class OrcaRuntimeWithSplitTerminal extends OrcaRuntimeWithStopExplicitlyClosedTabPtys {
  async splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      ratio?: number
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    if (
      opts.ratio !== undefined &&
      (!Number.isFinite(opts.ratio) || opts.ratio <= 0 || opts.ratio >= 1)
    ) {
      throw new Error('--ratio must be greater than 0 and less than 1')
    }
    const livePty = this.getLivePtyForHandle(handle)
    if (opts.ratio !== undefined) {
      const pty = livePty?.pty ?? this.resolveLocalDesktopTerminalSplitPty(handle)
      return await this.splitPtyBackedTerminal(pty, opts, createdWorktree, handle)
    }
    if (livePty) {
      return await this.splitPtyBackedTerminal(livePty.pty, opts, createdWorktree)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const direction = opts.direction ?? 'horizontal'

    const newLeafId = randomUUID()

    this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
      direction,
      command: opts.command,
      worktreeId: leaf.worktreeId,
      sourceLeafId: leaf.leafId,
      telemetrySource: opts.telemetrySource,
      newLeafId
    })

    const newHandle = await this.waitForLeafInTab(leaf.tabId, newLeafId)
    return {
      handle: newHandle,
      tabId: leaf.tabId,
      paneRuntimeId: leaf.paneRuntimeId,
      leafId: newLeafId
    }
  }

  protected resolveLocalDesktopTerminalSplitPty(handle: string): RuntimePtyWorktreeRecord {
    const runtimePty = this.getLivePtyForHandle(handle)
    if (runtimePty) {
      return runtimePty.pty
    }
    const { record, leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.ptyId) {
      throw new Error('--ratio requires a live native local desktop PTY')
    }
    this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId)
    const pty = this.ptysById.get(leaf.ptyId)
    if (
      !pty?.connected ||
      pty.ptyId !== leaf.ptyId ||
      record.tabId !== leaf.tabId ||
      record.leafId !== leaf.leafId ||
      record.worktreeId !== leaf.worktreeId ||
      pty.worktreeId !== leaf.worktreeId ||
      pty.tabId !== leaf.tabId ||
      pty.paneKey !== makePaneKey(leaf.tabId, leaf.leafId)
    ) {
      throw new Error('--ratio requires an owned live local desktop PTY binding')
    }
    return pty
  }

  protected async verifyLocalDesktopTerminalSplitPty(ptyId: string): Promise<void> {
    const live = await withTimeout(
      Promise.resolve().then(() => this.ptyController?.probePtyLiveness?.(ptyId) ?? null),
      TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS,
      null
    )
    if (live !== true) {
      throw new Error('--ratio requires an owned live native local desktop PTY')
    }
  }

  protected assertLocalDesktopTerminalSplit(
    pty: RuntimePtyWorktreeRecord,
    expected?: LocalDesktopSplitSource
  ): LocalDesktopSplitSource {
    const source = this.captureLocalDesktopTerminalSplitSource(pty, expected)
    if (!this.controllerKnowsPtyIsLive(pty.ptyId)) {
      throw new Error('--ratio requires an owned live native local desktop PTY')
    }
    return source
  }

  protected captureLocalDesktopTerminalSplitSource(
    pty: RuntimePtyWorktreeRecord,
    expected?: LocalDesktopSplitSource
  ): LocalDesktopSplitSource {
    const epoch = this.captureReadyGraphEpoch()
    const window = this.getAvailableAuthoritativeWindow()
    if (
      !window ||
      window.webContents?.isDestroyed?.() !== false ||
      !this.notifier?.revealTerminalSession ||
      (expected && (expected.window !== window || expected.epoch !== epoch))
    ) {
      throw new Error('runtime_unavailable')
    }
    if (
      !pty.connected ||
      this.ptysById.get(pty.ptyId) !== pty ||
      pty.connectionId !== null ||
      pty.isWsl === true ||
      pty.wslDistro ||
      (process.platform === 'win32' && pty.isWsl !== false) ||
      this.pairedRendererSessionOwnedPtyIds.has(pty.ptyId) ||
      (expected &&
        (expected.worktreeId !== pty.worktreeId ||
          expected.tabId !== pty.tabId ||
          expected.paneKey !== pty.paneKey ||
          expected.incarnationId !== pty.incarnationId))
    ) {
      throw new Error('--ratio requires an owned native local desktop PTY')
    }
    const folder = this.resolveFolderWorkspaceSelector(`id:${pty.worktreeId}`)
    const repos = this.store?.getRepos() ?? []
    if (folder) {
      const projectGroups = this.store?.getProjectGroups?.() ?? []
      const group = projectGroups.find((entry) => entry.id === folder.projectGroupId)
      const state = { folderWorkspaces: [folder], projectGroups, repos }
      if (
        !group ||
        !group.parentPath?.trim() ||
        !folder.folderPath?.trim() ||
        folder.connectionId ||
        group.connectionId ||
        (folder.executionHostId != null &&
          parseExecutionHostId(folder.executionHostId)?.kind !== 'local') ||
        (group.executionHostId != null &&
          parseExecutionHostId(group.executionHostId)?.kind !== 'local') ||
        resolveFolderWorkspaceHost(state, folder.id).kind !== 'local' ||
        this.resolveFolderWorkspaceConnectionId(folder) !== null ||
        findFolderWorkspaceCandidateRepos(state, folder.id).some((repo) => {
          const routing = resolveWorktreeHostRouting([repo], { repoId: repo.id })
          return routing.kind !== 'resolved' || routing.hostId !== 'local'
        })
      ) {
        throw new Error('--ratio requires affirmative local folder ownership')
      }
    } else {
      const worktree = parseExactWorktreeIdSelector(pty.worktreeId)
      const hostId = this.store?.getWorktreeMeta?.(pty.worktreeId)?.hostId
      const routing = worktree
        ? resolveWorktreeHostRouting(repos, { repoId: worktree.repoId, hostId })
        : null
      if (
        !routing ||
        routing.kind !== 'resolved' ||
        routing.hostId !== 'local' ||
        !routing.repo ||
        routing.repo.connectionId ||
        (hostId != null && parseExecutionHostId(hostId)?.kind !== 'local')
      ) {
        throw new Error('--ratio requires affirmative local worktree ownership')
      }
    }
    return {
      window,
      epoch,
      worktreeId: pty.worktreeId,
      tabId: pty.tabId,
      paneKey: pty.paneKey,
      incarnationId: pty.incarnationId
    }
  }
}
