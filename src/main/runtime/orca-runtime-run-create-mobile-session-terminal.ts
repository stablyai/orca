// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateMobileSessionTerminal } from './orca-runtime-create-mobile-session-terminal'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import type { IpcMainEvent } from 'electron'
import {
  MOBILE_TERMINAL_READY_FALLBACK_MS,
  MOBILE_TERMINAL_SURFACE_TIMEOUT_MS,
  isClientDisconnectedError
} from './orca-runtime-core'

export class OrcaRuntimeWithRunCreateMobileSessionTerminal extends OrcaRuntimeWithCreateMobileSessionTerminal {
  protected async runCreateMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      targetGroupId?: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      clientNavigationId?: string
      clientMutationId?: string
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const pairedCreate = Boolean(opts.clientNavigationId)
    const graphEpoch = this.captureReadyGraphEpoch()
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    const worktreeId = workspace.id
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    let afterDesktopTabId: string | undefined
    if (opts.afterTabId) {
      const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
      const anchor = snapshot?.tabs.find((tab) => tab.id === opts.afterTabId)
      if (!anchor) {
        throw new Error('after_tab_not_found')
      }
      afterDesktopTabId = anchor.type === 'terminal' ? anchor.parentTabId : anchor.id
    }
    const startupCommand = await this.resolveMobileSessionTerminalCommand(workspace, opts)
    this.assertStableReadyGraph(graphEpoch)
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const win = this.getAvailableAuthoritativeWindow()
    if (!win) {
      return await this.createRuntimeOwnedMobileSessionTerminal(
        worktreeId,
        opts.activate !== false,
        opts.afterTabId,
        {
          command: startupCommand.command,
          cwd,
          env: startupCommand.env,
          envToDelete: startupCommand.envToDelete,
          startupCommandDelivery: startupCommand.startupCommandDelivery,
          launchAgent: startupCommand.launchAgent,
          viewMode: opts.viewMode,
          targetGroupId: opts.targetGroupId,
          launchConfig: startupCommand.launchConfig,
          signal: opts.signal
        }
      )
    }
    if (win.webContents.isDestroyed?.()) {
      throw new Error('runtime_unavailable')
    }
    const releasePublicationThrottle = pairedCreate
      ? this.rendererPublicationThrottle.acquire(win.webContents)
      : () => {}
    try {
      const requestId = randomUUID()
      const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
          opts.signal?.removeEventListener('abort', onAbort)
          reject(new Error('Terminal creation timed out'))
        }, 10_000)
        // Why: a dead client connection cancels the wait; the renderer tab (and
        // its shell) stays alive for the host and mirrors on reconnect (#7718).
        const onAbort = (): void => {
          clearTimeout(timer)
          getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
          reject(new Error('client_disconnected'))
        }

        const handler = (
          event: IpcMainEvent,
          r: { requestId: string; tabId?: string; title?: string; error?: string }
        ): void => {
          if (event.sender !== win.webContents || r.requestId !== requestId) {
            return
          }
          clearTimeout(timer)
          getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
          opts.signal?.removeEventListener('abort', onAbort)
          if (r.error) {
            reject(new Error(r.error))
          } else {
            resolve({ tabId: r.tabId!, title: r.title ?? '' })
          }
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        getRuntimeDesktopSurface().onIpc('terminal:tabCreateReply', handler)
        win.webContents.send('terminal:requestTabCreate', {
          requestId,
          worktreeId,
          afterTabId: afterDesktopTabId,
          targetGroupId: opts.targetGroupId,
          command: startupCommand.command,
          cwd,
          ...(startupCommand.env ? { env: startupCommand.env } : {}),
          ...(startupCommand.envToDelete ? { envToDelete: startupCommand.envToDelete } : {}),
          ...(startupCommand.launchConfig ? { launchConfig: startupCommand.launchConfig } : {}),
          ...(startupCommand.launchAgent ? { launchAgent: startupCommand.launchAgent } : {}),
          ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
          startupCommandDelivery: startupCommand.startupCommandDelivery,
          source: 'runtime-session',
          activate: opts.activate
        })
      })

      if (opts.activate !== false) {
        this.notifier?.focusTerminal(reply.tabId, worktreeId, null)
      }
      // Why: register the wait before the renderer's PTY spawn arrives so that
      // spawn (registerPty) can publish the pty-backed surface main-side even if
      // graph-sync is stalled (#7587). Removed in the finally below.
      const pendingCreateKey = `${worktreeId}::${reply.tabId}`
      // Why: a rescue publishes into the active group (opts.targetGroupId is not
      // threaded); the renderer's reconciling publication then moves the tab to the
      // requested group, so any wrong-group placement is cosmetic and stall-window-only.
      this.pendingMobileTerminalCreatesByKey.set(pendingCreateKey, {
        activate: opts.activate !== false,
        paired: pairedCreate,
        selectIfNoActiveTab: true,
        ...(startupCommand.command ? { startupCommand: startupCommand.command } : {}),
        ...(opts.viewMode ? { viewMode: opts.viewMode } : {})
      })
      try {
        // Why: the PTY spawn and the tabCreate reply race on independent IPC
        // channels; if the spawn already registered, publish immediately so the
        // wait resolves without depending on a graph sync.
        this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, reply.tabId)
        const surface = await this.waitForMobileTerminalSurface(worktreeId, reply.tabId, {
          timeoutMs: MOBILE_TERMINAL_SURFACE_TIMEOUT_MS,
          signal: opts.signal
        })
        if (this.isReadyMobileTerminalSurface(surface)) {
          this.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
          return surface
        }
        const readySurface = await this.waitForMobileTerminalSurface(worktreeId, reply.tabId, {
          timeoutMs: MOBILE_TERMINAL_READY_FALLBACK_MS,
          requireReady: true,
          signal: opts.signal
        }).catch(() => null)
        if (readySurface) {
          this.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
          return readySurface
        }
        if (opts.signal?.aborted) {
          // Why: nobody awaits this create anymore; don't materialize or roll back — the renderer's own publication settles the tab.
          throw new Error('client_disconnected')
        }
        const pendingSurface = this.findMobileTerminalSurface(worktreeId, reply.tabId)
        if (!pendingSurface) {
          throw new Error('Timed out waiting for terminal surface after creation')
        }
        // Why: a hidden renderer can publish the tab shell before the PTY spawns; reuse the same identity so later focus adopts instead of creating another tab.
        return await this.createRuntimeOwnedMobileSessionTerminal(
          worktreeId,
          opts.activate !== false,
          opts.afterTabId,
          {
            command: startupCommand.command,
            cwd,
            env: startupCommand.env,
            envToDelete: startupCommand.envToDelete,
            startupCommandDelivery: startupCommand.startupCommandDelivery,
            identity: { tabId: pendingSurface.tab.parentTabId, leafId: pendingSurface.tab.leafId },
            launchAgent: startupCommand.launchAgent,
            viewMode: opts.viewMode,
            targetGroupId: opts.targetGroupId,
            launchConfig: startupCommand.launchConfig,
            signal: opts.signal
          }
        )
      } catch (error) {
        // Why: publication latency (hidden renderer) can trip the surface timeout; rescue only when a live PTY backs the tab, else a ghost tab skips rollback (#7587).
        if (this.findLiveRegisteredPtyForRendererTab(worktreeId, reply.tabId)) {
          const rescued = this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, reply.tabId)
          if (rescued) {
            this.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
            return rescued
          }
        }
        // Why: don't roll back on a client disconnect or a live shell already backing the tab — that would kill a visible terminal ("tab dies after ~10s", #7718).
        if (
          isClientDisconnectedError(error) ||
          this.hasLiveShellForRendererTab(worktreeId, reply.tabId)
        ) {
          throw error
        }
        // Why: renderer made the tab but no live PTY backs it (real spawn/handle failure); roll it back so it can't linger as a ghost in mobile snapshots.
        this.notifier?.closeTerminal(reply.tabId)
        throw error
      } finally {
        this.pendingMobileTerminalCreatesByKey.delete(pendingCreateKey)
      }
    } finally {
      releasePublicationThrottle()
    }
  }
}
