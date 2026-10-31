import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { RuntimeMobileSessionTabMove } from '../../shared/runtime-types'
import type { TerminalTabCreateReply } from '../../shared/terminal-reveal-identity'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import { requestAgentLaunchTabPublishFromRenderer } from './agent-launch-tab-publish-relay'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerRendererDocumentNavigation } from './renderer-document-navigation'
import { createRuntimeRendererNotificationSender } from './runtime-renderer-notification-sender'
import { requestSessionTabCloseFromRenderer } from './session-tab-close-request-relay'
import { revealTerminalPaneInWindow } from './terminal-pane-reveal-relay'
import { requestTerminalTabCloseFromRenderer } from './terminal-tab-close-request-relay'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'

let runtimeNotifierTokenCounter = 0
let activeRuntimeNotifierToken: number | null = null

export function registerRuntimeWindowLifecycle(
  mainWindow: BrowserWindow,
  runtime: OrcaRuntimeService
): void {
  const notifierToken = ++runtimeNotifierTokenCounter
  activeRuntimeNotifierToken = notifierToken
  runtime.attachWindow(mainWindow.id)
  const mainWebContents = mainWindow.webContents
  const rendererNotifications = createRuntimeRendererNotificationSender({
    isWindowDestroyed: () => mainWindow.isDestroyed(),
    webContents: mainWebContents,
    onFailure: (reason) => runtime.markGraphReloadFailed(mainWindow.id, reason)
  })
  const send = rendererNotifications.send
  runtime.setNotifier({
    worktreesChanged: (repoId, renamed, options) => {
      // Invalidate scan TTLs before notifying renderer or its immediate read can return stale mutation results.
      if (options?.invalidateGitScans !== false) {
        runWorktreeChangeInvalidators(repoId)
      }
      send('worktrees:changed', renamed ? { repoId, renamed } : { repoId })
    },
    worktreeBaseStatus: (event) => send('worktree:baseStatus', event),
    worktreeRemoteBranchConflict: (event) => send('worktree:remoteBranchConflict', event),
    reposChanged: () => send('repos:changed'),
    browserProfilesChanged: () => send('browser:session:profilesChanged'),
    automationsChanged: (payload) => send('automations:changed', payload),
    activateWorktree: (
      repoId,
      worktreeId,
      setup?: CreateWorktreeResult['setup'],
      startup?: WorktreeStartupLaunch,
      defaultTabs?: CreateWorktreeResult['defaultTabs'],
      providesInitialSurface?: boolean
    ) => {
      send('ui:activateWorktree', {
        repoId,
        worktreeId,
        ...(setup ? { setup } : {}),
        ...(startup ? { startup } : {}),
        ...(defaultTabs ? { defaultTabs } : {}),
        ...(providesInitialSurface ? { providesInitialSurface } : {})
      })
    },
    createTerminal: (worktreeId, opts) =>
      send('ui:createTerminal', {
        worktreeId,
        command: opts.command,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        title: opts.title,
        ...(opts.presentation ? { presentation: opts.presentation } : {})
      }),
    revealTerminalSession: (worktreeId, opts) =>
      new Promise((resolve, reject) => {
        const requestId = randomUUID()
        const expectedIdentity = opts.expectedProcessIdentity
          ? opts.tabId && opts.leafId
            ? { worktreeId, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId }
            : null
          : undefined
        if (expectedIdentity === null) {
          reject(new Error('terminal_reveal_identity_required'))
          return
        }
        const timer = setTimeout(() => {
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          reject(new Error('Terminal reveal timed out'))
        }, 10_000)
        const handler = (event: Electron.IpcMainEvent, reply: TerminalTabCreateReply): void => {
          // Renderer-supplied request IDs confer no authority; only this window can satisfy reveal.
          if (event.sender !== mainWebContents || reply.requestId !== requestId) {
            return
          }
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          if (reply.error) {
            reject(new Error(reply.error))
            return
          }
          if (
            expectedIdentity &&
            (!reply.identity ||
              reply.identity.worktreeId !== expectedIdentity.worktreeId ||
              reply.identity.tabId !== expectedIdentity.tabId ||
              reply.identity.leafId !== expectedIdentity.leafId ||
              reply.identity.ptyId !== expectedIdentity.ptyId)
          ) {
            reject(new Error('terminal_reveal_identity_mismatch'))
            return
          }
          resolve({
            tabId: reply.tabId!,
            title: reply.title,
            ...(reply.identity ? { identity: reply.identity } : {})
          })
        }
        ipcMain.on('terminal:tabCreateReply', handler)
        const sent = send('ui:createTerminal', {
          requestId,
          worktreeId,
          ptyId: opts.ptyId,
          title: opts.title ?? undefined,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
          ...(opts.launchToken ? { launchToken: opts.launchToken } : {}),
          ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
          ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
          ...(opts.targetGroupId ? { targetGroupId: opts.targetGroupId } : {}),
          ...(opts.afterTabId ? { afterTabId: opts.afterTabId } : {}),
          ...(opts.shellOverride ? { shellOverride: opts.shellOverride } : {}),
          activate: opts.activate !== false,
          ...(opts.presentation ? { presentation: opts.presentation } : {}),
          ...(opts.surfaceOwner === false ? { surfaceOwner: false } : {}),
          ...(opts.agentLaunchViewer ? { agentLaunchViewer: opts.agentLaunchViewer } : {}),
          // Pre-mint tabId to match the PTY paneKey so hook events reach the correct tab.
          ...(opts.tabId !== undefined ? { tabId: opts.tabId } : {}),
          ...(opts.leafId !== undefined ? { leafId: opts.leafId } : {}),
          ...(opts.splitFromLeafId !== undefined ? { splitFromLeafId: opts.splitFromLeafId } : {}),
          ...(opts.splitDirection !== undefined ? { splitDirection: opts.splitDirection } : {}),
          ...(opts.splitTelemetrySource !== undefined
            ? { splitTelemetrySource: opts.splitTelemetrySource }
            : {}),
          ...(opts.focus !== undefined ? { focus: opts.focus } : {})
        })
        if (!sent) {
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          reject(new Error('runtime_unavailable'))
        }
      }),
    publishAgentLaunchTab: (request) =>
      requestAgentLaunchTabPublishFromRenderer(mainWindow, request),
    agentLaunchPaneVerdict: (event) => send('ui:agentLaunchPaneVerdict', event),
    rememberLaunchRecipe: (recipe) => send('ui:launchRecipe', recipe),
    resolveLegacyWorkerTerminalRecovery: (paneKey, resolution, ptyId) =>
      send('agentStatus:legacyWorkerTerminalRecovery', {
        paneKey,
        resolution,
        ...(ptyId ? { ptyId } : {})
      }),
    splitTerminal: (tabId, paneRuntimeId, opts) => {
      send('ui:splitTerminal', {
        tabId,
        paneRuntimeId,
        direction: opts.direction,
        command: opts.command,
        worktreeId: opts.worktreeId,
        sourceLeafId: opts.sourceLeafId,
        telemetrySource: opts.telemetrySource,
        newLeafId: opts.newLeafId
      })
    },
    renameTerminal: (tabId, title, options) =>
      send('ui:renameTerminal', { tabId, title, ...options }),
    setPaneTitle: (tabId, leafId, title) => send('ui:setPaneTitle', { tabId, leafId, title }),
    focusTerminal: (tabId, worktreeId, leafId) =>
      send('ui:focusTerminal', { tabId, worktreeId, leafId }),
    revealTerminalPane: (target) => revealTerminalPaneInWindow(mainWindow, target),
    focusEditorTab: (tabId, worktreeId) => send('ui:focusEditorTab', { tabId, worktreeId }),
    closeSessionTab: (tabId, worktreeId) =>
      requestSessionTabCloseFromRenderer(mainWindow, tabId, worktreeId),
    moveSessionTab: (worktreeId: string, move: RuntimeMobileSessionTabMove) =>
      send('ui:moveSessionTab', { worktreeId, ...move }),
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId?, navigation?, position?) =>
      send('ui:openFileFromMobile', {
        worktreeId,
        filePath,
        relativePath,
        runtimeEnvironmentId,
        ...(navigation ? { navigation } : {}),
        ...(position ? { position } : {})
      }),
    revealEditorTab: (reveal) => send('ui:revealEditorTabFromRuntime', reveal),
    openDiff: (
      worktreeId,
      filePath,
      relativePath,
      staged,
      runtimeEnvironmentId?,
      navigation?,
      oldPath?
    ) =>
      send('ui:openDiffFromMobile', {
        worktreeId,
        filePath,
        relativePath,
        staged,
        runtimeEnvironmentId,
        ...(navigation ? { navigation } : {}),
        ...(oldPath ? { oldPath } : {})
      }),
    closeTerminal: (tabId) => send('ui:closeTerminal', { kind: 'tab', tabId }),
    closeTerminalPane: (tabId, leafId) => send('ui:closeTerminal', { kind: 'pane', tabId, leafId }),
    closeTerminalTab: (tabId, options) =>
      requestTerminalTabCloseFromRenderer(mainWindow, tabId, options),
    workspaceSleepChanged: (notice) => send('ui:workspaceSleep', notice),
    resumeSleepingAgents: (worktreeId) => send('ui:resumeSleepingAgents', { worktreeId }),
    terminalFitOverrideChanged: (ptyId, mode, cols, rows) =>
      send('runtime:terminalFitOverrideChanged', { ptyId, mode, cols, rows }),
    terminalDriverChanged: (ptyId, driver) =>
      send('runtime:terminalDriverChanged', { ptyId, driver }),
    nativeChatLaunchDraftResolved: (tabId, resolution) =>
      send('runtime:nativeChatLaunchDraftResolved', { tabId, ...resolution }),
    browserDriverChanged: (browserPageId, driver) =>
      send('runtime:browserDriverChanged', { browserPageId, driver }),
    browserRemoteViewersChanged: (browserPageId, hasRemoteViewers) =>
      send('runtime:browserRemoteViewersChanged', { browserPageId, hasRemoteViewers }),
    clientHostedBrowserRowsChanged: (event) => send('runtime:clientHostedBrowserRowsChanged', event)
  })
  // Switch point: the window reads its sidebar from main's feed and re-reads on each notice.
  const detachSidebarInputsNotices = ORCA_SIDEBAR_INPUTS_IS_MAIN
    ? runtime.onClientEvent(
        (event) => {
          if (event.type === 'sidebarInputsChanged') {
            send('runtime:sidebarInputsChanged', event)
          }
        },
        { consumesTerminalSideEffects: false }
      )
    : null
  registerRendererDocumentNavigation(mainWebContents, () => {
    rendererNotifications.onMainFrameReloadStarted()
    const fence = runtime.markRendererReloading(mainWindow.id)
    return () => {
      if (fence && runtime.markRendererReloadCancelled(mainWindow.id, fence)) {
        rendererNotifications.onMainFrameReloadCancelled()
      }
    }
  })
  mainWebContents.on('did-finish-load', () => {
    rendererNotifications.onMainFrameLoadFinished()
  })
  mainWebContents.on('render-process-gone', () => {
    rendererNotifications.onRendererProcessGone()
  })
  mainWindow.on('closed', () => {
    detachSidebarInputsNotices?.()
    rendererNotifications.close()
    runtime.markGraphUnavailable(mainWindow.id)
    if (activeRuntimeNotifierToken === notifierToken) {
      // Clear window-capturing notifier closures during windowless gaps to release destroyed graphs.
      runtime.setNotifier(null)
      activeRuntimeNotifierToken = null
    }
  })
}
