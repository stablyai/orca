import { OrcaRuntimeWithCreateMobileSessionTerminal } from './mobile-terminal-create'
import type { MobileTerminalCreateOptions } from './mobile-terminal-renderer-create'
import type { OwnedMobileTerminalCreateOptions } from './mobile-terminal-owned-create'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-types'
import {
  prepareStructuredChatCliFork,
  isStructuredChatCliForkSourceCurrent
} from '../../../ai-vault/structured-chat-cli-fork'
import { buildMobileTerminalChatFork } from './mobile-terminal-chat-fork'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { applyRemoteViewerLaunchEnv } from '../../remote-viewer-launch-env'
import { deterministicAgentSessionUuid } from '../../runtime-agent-launch-resolution'
import { rendererPublicationThrottle } from '../../../window/renderer-publication-throttle'
import { PROJECT_RUNTIME_REPAIR_REQUIRED_CODE } from '../../../../shared/project-runtime-repair-message'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { resolveSessionTabRow } from '../../../../shared/workspace-layout/old-client/old-client-session-tab-rows'

function resolveSavedChatForkAnchor(
  session: WorkspaceSessionState | null,
  worktreeId: string,
  rowId: string | undefined
): { afterDesktopTabId?: string; targetGroupId?: string } {
  if (!session || !rowId) {
    return {}
  }
  const workspace = loadWorkspaceLayoutWithoutReport(
    LOCAL_EXECUTION_HOST_ID,
    session,
    nameBasedLoadContext()
  ).layout.workspaces[worktreeId]
  const tab = workspace && resolveSessionTabRow(workspace, rowId)?.tab
  const group = tab && workspace?.groups.find((entry) => entry.tabOrder.includes(tab.id))
  // A live window can publish a chat before saving its layout; placement must not block its fork.
  return group && tab ? { afterDesktopTabId: tab.id, targetGroupId: group.id } : {}
}

export abstract class OrcaRuntimeWithMobileChatForkCreate extends OrcaRuntimeWithCreateMobileSessionTerminal {
  protected abstract captureReadyGraphEpoch(): number
  protected abstract assertStableReadyGraph(expectedGraphEpoch: number): void
  protected abstract createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts?: OwnedMobileTerminalCreateOptions
  ): Promise<RuntimeMobileSessionCreateTerminalResult>

  protected async createMobileChatForkTerminal(args: {
    workspace: TerminalWorkspaceLaunchScope
    worktreeId: string
    opts: MobileTerminalCreateOptions
    afterTabId?: string
    graphEpoch: number
  }): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const { workspace, worktreeId, opts, afterTabId, graphEpoch } = args
    const sourceId = opts.sourceChatFork?.sessionId
    const mutationId = opts.clientMutationId
    if (
      !sourceId ||
      !mutationId ||
      workspace.connectionId ||
      isWslUncPath(workspace.path) ||
      !this.store
    ) {
      throw new Error('chat_fork_runtime_incompatible')
    }
    const store = this.store
    const preflight = await (async () => {
      try {
        await this.ensureStructuredAgentSessionHost()
        const prepared = await prepareStructuredChatCliFork(
          { sourceChat: { sessionId: sourceId, workspaceId: worktreeId }, fork: true },
          (prepareArgs) => this.aiVault.prepare(prepareArgs)
        )
        this.assertStableReadyGraph(graphEpoch)
        if (
          !isStructuredChatCliForkSourceCurrent(sourceId, worktreeId) ||
          !this.mobileSessionTabsByWorktree
            .get(worktreeId)
            ?.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === sourceId)
        ) {
          throw new Error('chat_fork_source_unavailable')
        }
        if (opts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        const sourceAgent = prepared.cliForkSource?.agent
        if (!sourceAgent || !isTuiAgent(sourceAgent)) {
          throw new Error('chat_fork_source_unavailable')
        }
        const settings = store.getSettings()
        const launchRuntime = this.resolveAgentLaunchRuntime(workspace, sourceAgent)
        const startup = applyRemoteViewerLaunchEnv(
          buildMobileTerminalChatFork({
            prepared,
            settings,
            runtime: launchRuntime
          }),
          opts.terminalImageViewerSupported
        )
        const win = this.getAvailableAuthoritativeWindow()
        const placement = resolveSavedChatForkAnchor(
          this.getWorkspaceSessionForWorktree(worktreeId),
          worktreeId,
          afterTabId
        )
        const phoneAnchor = this.mobileSessionTabsByWorktree
          .get(worktreeId)
          ?.tabs.some((tab) => tab.id === afterTabId)
          ? afterTabId
          : undefined
        return {
          startup,
          launchRuntime,
          win,
          phoneAnchor,
          ...placement,
          targetGroupId: opts.targetGroupId ?? placement.targetGroupId
        }
      } catch (error) {
        const code =
          error instanceof OrchestrationError
            ? error.code
            : error instanceof Error
              ? error.message
              : ''
        if (
          code === 'chat_fork_source_unavailable' ||
          code === 'chat_fork_runtime_incompatible' ||
          code === PROJECT_RUNTIME_REPAIR_REQUIRED_CODE ||
          code === 'runtime_unavailable' ||
          code === 'client_disconnected'
        ) {
          throw error
        }
        console.warn('[mobile-chat-fork] preparation failed:', error)
        throw new Error('chat_fork_source_unavailable')
      }
    })()
    const { startup, launchRuntime, win, phoneAnchor, targetGroupId, afterDesktopTabId } = preflight
    const clientIdentity = opts.clientNavigationId ?? 'local'
    const seed = `${clientIdentity}\0${worktreeId}\0${mutationId}`
    const releaseThrottle =
      win && !win.webContents.isDestroyed?.()
        ? rendererPublicationThrottle.acquire(win.webContents)
        : () => {}
    try {
      const created = await this.createRuntimeOwnedMobileSessionTerminal(
        worktreeId,
        opts.activate !== false,
        phoneAnchor,
        {
          ...startup,
          identity: {
            tabId: deterministicAgentSessionUuid(`mobile-chat-fork-tab\0${seed}`),
            leafId: deterministicAgentSessionUuid(`mobile-chat-fork-leaf\0${seed}`)
          },
          createMutation: { clientIdentity, id: mutationId },
          afterDesktopTabId,
          targetGroupId,
          viewMode: 'terminal',
          supportsSplitGroupPlacement: opts.supportsSplitGroupPlacement,
          presentation: 'background',
          signal: opts.signal
        }
      )
      if (!win) {
        return created
      }
      const tab = created.tab
      const pty =
        typeof tab.terminal === 'string' ? this.getLivePtyForHandle(tab.terminal)?.pty : null
      if (
        typeof tab.terminal !== 'string' ||
        !pty ||
        !tab.ptyId ||
        !tab.incarnationId ||
        pty.incarnationId !== tab.incarnationId ||
        win.webContents.isDestroyed?.()
      ) {
        return { ...created, warning: 'desktop-tab-not-shown' }
      }
      try {
        if (!this.notifier?.revealTerminalSession) {
          throw new Error('runtime_unavailable')
        }
        const revealed = await this.notifier.revealTerminalSession(worktreeId, {
          ptyId: tab.ptyId,
          tabId: tab.parentTabId,
          leafId: tab.leafId,
          title: pty.title,
          ...(startup.cwd ? { cwd: startup.cwd } : {}),
          ...(pty.launchConfig ? { launchConfig: pty.launchConfig } : {}),
          ...(pty.launchToken ? { launchToken: pty.launchToken } : {}),
          ...(pty.launchAgent ? { launchAgent: pty.launchAgent } : {}),
          viewMode: 'terminal',
          ...(targetGroupId ? { targetGroupId } : {}),
          ...(afterDesktopTabId ? { afterTabId: afterDesktopTabId } : {}),
          ...(launchRuntime.pty.shellOverride
            ? { shellOverride: launchRuntime.pty.shellOverride }
            : {}),
          activate: false,
          focus: false,
          presentation: 'background',
          surfaceOwner: false,
          expectedProcessIdentity: {
            terminalHandle: tab.terminal,
            incarnationId: tab.incarnationId
          }
        })
        if (
          !revealed ||
          revealed.tabId !== tab.parentTabId ||
          !revealed.identity ||
          revealed.identity.ptyId !== tab.ptyId ||
          revealed.identity.leafId !== tab.leafId
        ) {
          throw new Error('terminal_reveal_identity_mismatch')
        }
        if (this.getLivePtyForHandle(tab.terminal)?.pty.incarnationId !== tab.incarnationId) {
          throw new Error('terminal_reveal_identity_mismatch')
        }
      } catch (error) {
        console.warn('[mobile-chat-fork] desktop materialization failed:', error)
        return { ...created, warning: 'desktop-tab-not-shown' }
      }
      return created
    } finally {
      releaseThrottle()
    }
  }
}
