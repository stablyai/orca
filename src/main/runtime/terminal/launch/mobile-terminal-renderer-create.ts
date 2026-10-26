import { applyRemoteViewerLaunchEnv } from '../../remote-viewer-launch-env'
import type { MobileTerminalCommandOptions, MobileTerminalCommand } from './mobile-terminal-startup'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import { OrcaRuntimeWithMobileChatForkCreate } from './mobile-terminal-chat-fork-create'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { getRuntimeDesktopSurface } from '../../runtime-desktop-surface'
import type { IpcMainEvent } from 'electron'
import {
  MOBILE_TERMINAL_READY_FALLBACK_MS,
  MOBILE_TERMINAL_SURFACE_TIMEOUT_MS,
  isClientDisconnectedError
} from '../../orca-runtime-core'
import { rendererPublicationThrottle } from '../../../window/renderer-publication-throttle'
import { deterministicAgentSessionUuid } from '../../runtime-agent-launch-resolution'
import { assertMobileTerminalShellSupported } from './mobile-terminal-shell-refusal'
import { anchorTabOfCreate, mainPlacedAfter } from './mobile-terminal-create-anchor'

export type MobileTerminalCreateOptions = {
  terminalImageViewerSupported?: boolean
  afterTabId?: string
  sourceChatFork?: { sessionId: string }
  targetGroupId?: string
  command?: string
  shellOverride?: string
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
  supportsSplitGroupPlacement?: boolean
  signal?: AbortSignal
}

export abstract class OrcaRuntimeWithRunCreateMobileSessionTerminal extends OrcaRuntimeWithMobileChatForkCreate {
  protected abstract resolveMobileSessionTerminalCommand(
    workspace: TerminalWorkspaceLaunchScope,
    opts: MobileTerminalCommandOptions
  ): Promise<MobileTerminalCommand>

  protected abstract ensurePtyBackedMobileSurfaceForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null

  protected abstract waitForMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options?: { timeoutMs?: number; requireReady?: boolean; signal?: AbortSignal }
  ): Promise<RuntimeMobileSessionCreateTerminalResult>

  protected abstract isReadyMobileTerminalSurface(
    surface: RuntimeMobileSessionCreateTerminalResult | null
  ): boolean

  protected abstract deliverPendingStartupCommandToBareRendererPty(
    worktreeId: string,
    tabId: string
  ): void

  protected abstract findMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options?: { requireReady?: boolean }
  ): RuntimeMobileSessionCreateTerminalResult | null

  protected abstract findLiveRegisteredPtyForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimePtyWorktreeRecord | null

  protected abstract hasLiveShellForRendererTab(worktreeId: string, tabId: string): boolean

  protected async runCreateMobileSessionTerminal(
    worktreeSelector: string,
    opts: MobileTerminalCreateOptions = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const pairedCreate = Boolean(opts.clientNavigationId)
    const graphEpoch = this.captureReadyGraphEpoch()
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    const worktreeId = workspace.id
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    assertMobileTerminalShellSupported(this.store, workspace, opts.shellOverride, cwd)
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    // Older mobile clients optimistically append; match until they advertise grouped placement.
    const requestedAfterTabId = opts.afterTabId
    const afterTabId =
      opts.clientNavigationId && opts.supportsSplitGroupPlacement === false
        ? undefined
        : requestedAfterTabId
    if (opts.sourceChatFork) {
      return this.createMobileChatForkTerminal({
        workspace,
        worktreeId,
        opts,
        afterTabId,
        graphEpoch
      })
    }
    const afterDesktopTabId = anchorTabOfCreate(
      this.mobileSessionTabsByWorktree.get(worktreeId)?.tabs,
      requestedAfterTabId,
      afterTabId !== undefined
    )
    const startupCommand = applyRemoteViewerLaunchEnv(
      await this.resolveMobileSessionTerminalCommand(workspace, opts),
      opts.terminalImageViewerSupported
    )
    this.assertStableReadyGraph(graphEpoch)
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    if (opts.clientMutationId && startupCommand.command && startupCommand.launchAgent === 'qoder') {
      const clientIdentity = opts.clientNavigationId ?? 'local'
      const seed = `${clientIdentity}\0${worktreeId}\0${opts.clientMutationId}`
      // A command-bearing retry must reconcile the owning PTY before delivering the resume again.
      return await this.createRuntimeOwnedMobileSessionTerminal(
        worktreeId,
        opts.activate !== false,
        afterTabId,
        {
          ...startupCommand,
          cwd,
          identity: {
            tabId: deterministicAgentSessionUuid(`mobile-qoder-tab\0${seed}`),
            leafId: deterministicAgentSessionUuid(`mobile-qoder-leaf\0${seed}`)
          },
          createMutation: { clientIdentity, id: opts.clientMutationId },
          viewMode: opts.viewMode,
          targetGroupId: opts.targetGroupId,
          supportsSplitGroupPlacement: opts.supportsSplitGroupPlacement,
          signal: opts.signal
        }
      )
    }
    const win = this.getAvailableAuthoritativeWindow()
    if (!win) {
      return await this.createRuntimeOwnedMobileSessionTerminal(
        worktreeId,
        opts.activate !== false,
        afterTabId,
        {
          command: startupCommand.command,
          ...(opts.shellOverride ? { shellOverride: opts.shellOverride } : {}),
          cwd,
          env: startupCommand.env,
          envToDelete: startupCommand.envToDelete,
          startupCommandDelivery: startupCommand.startupCommandDelivery,
          launchAgent: startupCommand.launchAgent,
          viewMode: opts.viewMode,
          targetGroupId: opts.targetGroupId,
          ...mainPlacedAfter(
            () => this.mainLayoutTabOfRow(worktreeId, requestedAfterTabId),
            afterDesktopTabId
          ),
          supportsSplitGroupPlacement: opts.supportsSplitGroupPlacement,
          launchConfig: startupCommand.launchConfig,
          launchRuntime: startupCommand.launchRuntime,
          signal: opts.signal
        }
      )
    }
    if (win.webContents.isDestroyed?.()) {
      throw new Error('runtime_unavailable')
    }
    const releasePublicationThrottle = pairedCreate
      ? rendererPublicationThrottle.acquire(win.webContents)
      : () => {}
    try {
      const requestId = randomUUID()
      const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
          opts.signal?.removeEventListener('abort', onAbort)
          reject(new Error('Terminal creation timed out'))
        }, 10_000)
        // Disconnect cancels only this wait; preserve the renderer tab/shell for host use and reconnect mirrors (#7718).
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
          ...(opts.shellOverride ? { shellOverride: opts.shellOverride } : {}),
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
      // Register before spawn arrival so registerPty can publish despite stalled graph sync; remove in finally (#7587).
      const pendingCreateKey = `${worktreeId}::${reply.tabId}`
      // Rescue uses the active group; renderer reconciliation later moves the tab into its requested group.
      this.pendingMobileTerminalCreatesByKey.set(pendingCreateKey, {
        activate: opts.activate !== false,
        paired: pairedCreate,
        selectIfNoActiveTab: true,
        ...(startupCommand.command ? { startupCommand: startupCommand.command } : {}),
        ...(opts.viewMode ? { viewMode: opts.viewMode } : {})
      })
      try {
        // Spawn and tabCreate replies race across IPC channels; publish already-registered PTYs without waiting for graph sync.
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
          // Disconnected callers no longer await creation; let renderer publication settle the tab.
          throw new Error('client_disconnected')
        }
        const pendingSurface = this.findMobileTerminalSurface(worktreeId, reply.tabId)
        if (!pendingSurface) {
          throw new Error('Timed out waiting for terminal surface after creation')
        }
        // Hidden renderers may publish tab shells before spawn; reuse identity so later focus adopts the tab.
        return await this.createRuntimeOwnedMobileSessionTerminal(
          worktreeId,
          opts.activate !== false,
          afterTabId,
          {
            command: startupCommand.command,
            ...(opts.shellOverride ? { shellOverride: opts.shellOverride } : {}),
            cwd,
            env: startupCommand.env,
            envToDelete: startupCommand.envToDelete,
            startupCommandDelivery: startupCommand.startupCommandDelivery,
            identity: { tabId: pendingSurface.tab.parentTabId, leafId: pendingSurface.tab.leafId },
            launchAgent: startupCommand.launchAgent,
            viewMode: opts.viewMode,
            targetGroupId: opts.targetGroupId,
            supportsSplitGroupPlacement: opts.supportsSplitGroupPlacement,
            launchConfig: startupCommand.launchConfig,
            launchRuntime: startupCommand.launchRuntime,
            signal: opts.signal
          }
        )
      } catch (error) {
        // Hidden-renderer publication can time out; rescue only a live-backed tab or rollback would leave a ghost (#7587).
        if (this.findLiveRegisteredPtyForRendererTab(worktreeId, reply.tabId)) {
          const rescued = this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, reply.tabId)
          if (rescued) {
            this.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
            return rescued
          }
        }
        // Disconnect or a live backing shell must never trigger tab rollback (#7718).
        if (
          isClientDisconnectedError(error) ||
          this.hasLiveShellForRendererTab(worktreeId, reply.tabId)
        ) {
          throw error
        }
        // A real spawn/handle failure left no live backing PTY; remove the ghost tab.
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
