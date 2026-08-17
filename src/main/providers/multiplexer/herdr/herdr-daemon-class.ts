// oxlint-disable max-lines -- Herdr daemon class is a cohesive implementation that exceeds the line budget
import type {
  HerdrTransport,
  HerdrServerRequest,
  HerdrServerReply,
  HerdrNotification
} from './herdr-transport'
import { HerdrRuntimeError } from './herdr-runtime-contract'
import { platform } from 'node:process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import {
  getHerdrDataDir,
  getDefaultShell,
  getDefaultShellArgs,
  getPanePtyPath,
  createDataDirs
} from './herdr-daemon-helpers'
import {
  detectAgentFromBuffer,
  getAgentEnv,
  findAgentManifest,
  HERDR_AGENT_MANIFESTS
} from './herdr-daemon-agent'
import { HerdrDaemonSshStore } from './herdr-daemon-ssh-store'
import { SshConnection } from '../../../ssh/ssh-connection'
import type { ClientChannel } from 'ssh2'
import { HerdrDaemonModel } from './herdr-daemon-model'
import {
  moveWorkspace,
  moveWorkspaceBlock,
  moveTab,
  closeTab,
  swapPanes,
  setWorkspaceMetadata,
  setWorkspaceWorktree
} from './herdr-daemon-model-ops'
import type { ModelPane } from './herdr-daemon-model-types'
import {
  herdrExportLayout,
  herdrLayoutSnapshot,
  herdrSessionSnapshot
} from './herdr-daemon-snapshot'
import { paneEdges, paneNeighbor } from './herdr-daemon-layout-geometry'
import { DEFAULT_AREA } from './herdr-daemon-model-types'
import { buildHerdrApiSchema, HERDR_PROTOCOL_VERSION } from './herdr-daemon-schema'
import { saveSession, loadSession } from './herdr-daemon-persistence'
import { buildPaneReadResult, stripAnsiEscape } from './herdr-pane-read'
import type { LayoutNode } from './herdr-socket-types'

export type HerdrSocketEventData = { type: string; [key: string]: unknown }

const HERDR_EVENT_KINDS = new Set([
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.closed',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.focused',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.renamed',
  'tab.moved',
  'tab.focused',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'pane.agent_status_changed',
  'pane.output_matched',
  'pane.scroll_changed',
  'layout.updated'
])

type ProtocolPaneState = {
  pty: pty.IPty
  buffer: string
  sequence: number
  cols: number
  rows: number
}

type RemotePaneState = {
  channel: ClientChannel
  connectionId: string
  buffer: string
  sequence: number
  cols: number
  rows: number
}

export class HerdrDaemon {
  private dataDir: string
  private readonly model = new HerdrDaemonModel('orca')
  private readonly protocolPanes = new Map<string, ProtocolPaneState>()
  private readonly remotePanes = new Map<string, RemotePaneState>()
  private readonly eventBus = new EventEmitter()
  private agentView: {
    source: string
    label?: string | null
    filter?: unknown
    sort?: unknown[]
  } | null = null
  private windowTitle: string | null = null
  private readonly plugins = new Map<string, { name: string; path?: string; enabled: boolean }>()
  private readonly pluginLogs: { name: string; message: string; ts: number }[] = []
  private readonly integrations = new Set<string>()
  private saveTimer: NodeJS.Timeout | null = null
  private readonly sshStore: HerdrDaemonSshStore

  constructor(
    private readonly transport: HerdrTransport,
    sshStore?: HerdrDaemonSshStore
  ) {
    this.dataDir = getHerdrDataDir()
    createDataDirs(this.dataDir)
    this.sshStore =
      sshStore ??
      new HerdrDaemonSshStore(
        (targetId, params, onStateChange) =>
          new SshConnection(
            {
              id: targetId,
              label: params.configHost ?? params.host,
              host: params.host,
              port: params.port ?? 22,
              username: params.username ?? '',
              identityFile: params.identityFile,
              configHost: params.configHost,
              source: 'manual'
            },
            {
              onStateChange: (id, state) => {
                onStateChange(id, state)
                this.handleSshStateChange(id, state)
              }
            }
          )
      )
    this.setupTransport()
    this.restoreOnBoot()
  }

  private restoreOnBoot(): void {
    const { restored, paneBuffers } = loadSession(
      this.model,
      this.model.sessionName,
      HERDR_PROTOCOL_VERSION
    )
    if (!restored) {
      return
    }
    for (const pane of this.model.listPanes()) {
      if (pane.connection_id) {
        continue
      }
      // Why: a saved cwd that no longer exists spawns a shell that exits
      // immediately (status 1), leaving the pane dead after every restart.
      const cwd = existsSync(pane.cwd) ? pane.cwd : this.defaultProtocolCwd()
      this.spawnProtocolPane(pane.pane_id, cwd)
      const state = this.protocolPanes.get(pane.pane_id)
      if (state) {
        const savedBuffer = paneBuffers.get(pane.pane_id)
        if (savedBuffer) {
          state.buffer = savedBuffer
        }
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      return
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const paneBuffers = new Map<string, string>()
      for (const [paneId, state] of this.protocolPanes) {
        paneBuffers.set(paneId, state.buffer)
      }
      try {
        saveSession(this.model, this.model.sessionName, HERDR_PROTOCOL_VERSION, paneBuffers)
      } catch {
        // Why: a failed save must not crash the daemon; the next mutation retries.
      }
    }, 1000)
    this.saveTimer.unref()
  }

  private setupTransport(): void {
    this.transport.on('request', (request: HerdrServerRequest) => {
      this.handleRequest(request).catch((err) => {
        request.respondError(err)
      })
    })

    this.transport.on('disconnect', () => {
      // Client disconnected - clean up if needed
    })
  }

  private async handleRequest(request: HerdrServerRequest): Promise<void> {
    const { method, params } = request

    try {
      let result: unknown

      switch (method) {
        case 'ping':
          result = { ok: true }
          break
        case 'api.schema':
          result = this.handleApiSchema()
          break
        case 'session.snapshot':
          result = { snapshot: herdrSessionSnapshot(this.model, HERDR_PROTOCOL_VERSION) }
          break
        case 'session.list':
          result = this.handleSessionList()
          break
        case 'workspace.create':
          result = this.handleWorkspaceCreate(
            params as {
              label: string
              cwd?: string
              focus?: boolean
              tokens?: Record<string, string>
              worktree?: { checkout_path: string }
            }
          )
          break
        case 'workspace.list':
          result = this.handleWorkspaceList()
          break
        case 'workspace.get':
          result = this.handleWorkspaceGet(params as { workspace_id: string })
          break
        case 'workspace.rename':
          result = this.handleWorkspaceRename(params as { workspace_id: string; label: string })
          break
        case 'workspace.focus':
          result = this.handleWorkspaceFocus(params as { workspace_id: string })
          break
        case 'workspace.close':
          result = this.handleWorkspaceClose(params as { workspace_id: string })
          break
        case 'tab.create':
          result = this.handleTabCreate(
            params as { workspace_id: string; label: string; cwd?: string; focus?: boolean }
          )
          break
        case 'tab.list':
          result = this.handleTabList()
          break
        case 'tab.get':
          result = this.handleTabGet(params as { tab_id: string })
          break
        case 'tab.focus':
          result = this.handleTabFocus(params as { tab_id: string })
          break
        case 'tab.rename':
          result = this.handleTabRename(params as { tab_id: string; label: string })
          break
        case 'tab.move':
          result = this.handleTabMove(params as { tab_id: string; insert_index: number })
          break
        case 'tab.close':
          result = this.handleTabClose(params as { tab_id: string })
          break
        case 'workspace.report_metadata':
          result = this.handleWorkspaceReportMetadata(
            params as {
              workspace_id: string
              source: string
              tokens?: Record<string, string>
            }
          )
          break
        case 'workspace.move':
          result = this.handleWorkspaceMove(
            params as { workspace_id: string; insert_index: number }
          )
          break
        case 'workspace.move_block':
          result = this.handleWorkspaceMoveBlock(
            params as { workspace_ids: string[]; before_workspace_id?: string | null }
          )
          break
        case 'worktree.open':
        case 'worktree.create':
          result = this.handleWorktreeOpen(
            params as {
              path?: string
              branch?: string
              label?: string
              focus?: boolean
              base?: string
              cwd?: string
            }
          )
          break
        case 'worktree.list':
          result = this.handleWorktreeList()
          break
        case 'worktree.remove':
          result = this.handleWorktreeRemove(params as { workspace_id: string })
          break
        case 'pane.neighbor':
          result = this.handlePaneNeighbor(
            params as { direction: 'left' | 'right' | 'up' | 'down'; pane_id?: string | null }
          )
          break
        case 'pane.edges':
          result = this.handlePaneEdges(params as { pane_id?: string | null })
          break
        case 'pane.swap':
          result = this.handlePaneSwap(
            params as {
              pane_id?: string | null
              source_pane_id?: string | null
              target_pane_id?: string | null
              direction?: 'left' | 'right' | 'up' | 'down'
            }
          )
          break
        case 'pane.move':
          result = this.handlePaneMove(
            params as {
              pane_id: string
              destination: {
                type: 'tab' | 'new_tab' | 'new_workspace'
                tab_id?: string
                split?: 'right' | 'down'
                target_pane_id?: string
                ratio?: number
                workspace_id?: string
                label?: string
                tab_label?: string
              }
              focus?: boolean
            }
          )
          break
        case 'pane.focus_direction':
          result = this.handlePaneFocusDirection(
            params as { direction: 'left' | 'right' | 'up' | 'down'; pane_id?: string | null }
          )
          break
        case 'pane.focus':
          result = this.handlePaneFocus(params as { pane_id: string })
          break
        case 'pane.list':
          result = this.handlePaneList()
          break
        case 'pane.current':
          result = this.handlePaneCurrent()
          break
        case 'pane.get':
          result = this.handlePaneGet(params as { pane_id: string })
          break
        case 'pane.create':
          result = await this.handlePaneCreate(
            params as {
              target: { project: string; workspace: string; tab: string; leaf: string }
              options: {
                cols: number
                rows: number
                cwd?: string
                env?: Record<string, string>
                command?: string
                launchAgent?: string
              }
            }
          )
          break
        case 'pane.close':
          result = await this.handlePaneClose(params as { pane_id: string })
          break
        case 'pane.split':
          result = await this.handlePaneSplit(
            params as { pane_id: string; direction: 'right' | 'down'; ratio?: number }
          )
          break
        case 'pane.resize':
          result = await this.handlePaneResize(
            params as {
              pane_id: string
              cols?: number
              rows?: number
              direction?: 'left' | 'right' | 'up' | 'down'
              amount?: number
            }
          )
          break
        case 'pane.cwd':
          result = this.handlePaneCwd(params as { pane_id: string })
          break
        case 'layout.export':
          result = this.handleLayoutExport(
            params as { pane_id?: string | null; tab_id?: string | null }
          )
          break
        case 'layout.set_split_ratio':
          result = this.handleLayoutSetSplitRatio(
            params as {
              pane_id?: string | null
              path?: boolean[]
              ratio: number
              tab_id?: string | null
            }
          )
          break
        case 'layout.apply':
          result = await this.handleLayoutApply(
            params as {
              root: LayoutNode
              focus?: boolean
              tab_id?: string | null
              tab_label?: string | null
              workspace_id?: string | null
              workspace_label?: string | null
            }
          )
          break
        case 'pane.send_keys':
          result = await this.handlePaneSendKeys(params as { pane_id: string; keys: string[] })
          break
        case 'events.subscribe':
          result = this.handleEventsSubscribe(
            params as { subscriptions?: { type: string }[] | { type: string } },
            request
          )
          break
        case 'events.wait':
          result = await this.handleEventsWait(
            params as {
              match?: { type: string; pane_id?: string; workspace_id?: string; tab_id?: string }
              timeout_ms?: number
            }
          )
          break
        case 'pane.send_text':
          result = await this.handleProtocolPaneSend(params as { pane_id: string; text: string })
          break
        case 'pane.send_input':
          result = await this.handleProtocolPaneSendInput(
            params as { pane_id: string; keys?: string[]; text?: string }
          )
          break
        case 'pane.read':
          result = this.handleProtocolPaneRead(
            params as {
              pane_id: string
              format?: 'text' | 'ansi'
              lines?: number | null
              source: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'
              strip_ansi?: boolean
            }
          )
          break
        case 'pane.wait_for_output':
          result = await this.handleProtocolPaneWaitForOutput(
            params as {
              pane_id: string
              match?: { type: 'substring' | 'regex'; value: string }
              lines?: number | null
              timeout_ms?: number
              revision?: number
            }
          )
          break
        case 'pane.rename':
          result = this.handleProtocolPaneRename(params as { pane_id: string; label: string })
          break
        case 'pane.process_info':
          result = this.handleProtocolPaneProcessInfo(params as { pane_id: string })
          break
        case 'pane.layout':
          result = this.handleProtocolPaneLayout(params as { pane_id: string })
          break
        case 'pane.zoom':
          result = this.handleProtocolPaneZoom(params as { pane_id: string })
          break
        case 'pane.report_metadata':
          result = this.handleProtocolPaneReportMetadata(
            params as {
              pane_id: string
              tokens?: Record<string, string>
              source?: string
              metadata?: Record<string, unknown>
            }
          )
          break
        case 'pane.report_agent':
          result = this.handleProtocolPaneReportAgent(params as { pane_id: string; agent: string })
          break
        case 'pane.report_agent_session':
          result = this.handleProtocolPaneReportAgentSession(
            params as { pane_id: string; agent: string; agent_session?: string }
          )
          break
        case 'pane.release_agent':
          result = this.handleProtocolPaneReleaseAgent(params as { pane_id: string })
          break
        case 'pane.clear_agent_authority':
          result = this.handleProtocolPaneClearAgentAuthority(params as { pane_id: string })
          break
        case 'agent.list':
          result = this.handleAgentList()
          break
        case 'agent.get':
          result = this.handleAgentGet(params as { target: string })
          break
        case 'agent.wait':
          result = await this.handleAgentWait(
            params as { target: string; until: string[]; timeout_ms?: number }
          )
          break
        case 'agent.read':
          result = this.handleAgentRead(
            params as {
              target: string
              source?: string
              lines?: number | null
              strip_ansi?: boolean
              format?: 'text' | 'ansi'
            }
          )
          break
        case 'agent.rename':
          result = this.handleAgentRename(params as { target: string; name: string })
          break
        case 'agent.focus':
          result = this.handleAgentFocus(params as { target: string })
          break
        case 'agent.explain':
          result = this.handleAgentExplain(params as { target: string })
          break
        case 'agent.start':
          result = await this.handleAgentStart(
            params as {
              name: string
              kind: string
              pane_id: string
              args?: string[]
              timeout_ms?: number
            }
          )
          break
        case 'agent.prompt':
          result = await this.handleAgentPrompt(
            params as {
              target: string
              text: string
              wait?: boolean
              until?: string[]
              timeout_ms?: number
            }
          )
          break
        case 'agent.send_keys':
          result = await this.handleAgentSendKeys(params as { target: string; keys: string[] })
          break
        case 'agent.view.set':
          result = this.handleAgentViewSet(
            params as {
              source: string
              label?: string | null
              filter?: unknown
              sort?: unknown[]
            }
          )
          break
        case 'agent.view.clear':
          result = this.handleAgentViewClear(params as { source?: string | null })
          break
        case 'server.agent_manifests':
          result = this.handleServerAgentManifests()
          break
        case 'server.reload_agent_manifests':
          result = this.handleServerReloadAgentManifests()
          break
        case 'server.live_handoff':
          result = this.handleServerLiveHandoff(
            params as {
              expected_protocol?: number | null
              expected_version?: string | null
              import_exe?: string | null
            }
          )
          break
        case 'server.stop':
          result = this.handleServerStop()
          break
        case 'server.reload_config':
          result = this.handleServerReloadConfig()
          break
        case 'notification.show':
          result = this.handleNotificationShow(
            params as {
              title: string
              body?: string
              position?: string
              sound?: string
            }
          )
          break
        case 'popup.close':
          result = this.handlePopupClose(params as { id?: string | null })
          break
        case 'client.window_title.set':
          result = this.handleClientWindowTitleSet(params as { title: string })
          break
        case 'client.window_title.clear':
          result = this.handleClientWindowTitleClear()
          break
        case 'plugin.link':
          result = this.handlePluginLink(params as { name: string; path?: string })
          break
        case 'plugin.list':
          result = this.handlePluginList()
          break
        case 'plugin.unlink':
          result = this.handlePluginUnlink(params as { name: string })
          break
        case 'plugin.enable':
          result = this.handlePluginEnable(params as { name: string })
          break
        case 'plugin.disable':
          result = this.handlePluginDisable(params as { name: string })
          break
        case 'plugin.action.list':
          result = this.handlePluginActionList(params as { name: string })
          break
        case 'plugin.action.invoke':
          result = this.handlePluginActionInvoke(
            params as { name: string; action: string; args?: unknown[] }
          )
          break
        case 'plugin.log.list':
          result = this.handlePluginLogList(params as { name?: string | null })
          break
        case 'plugin.pane.open':
          result = this.handlePluginPaneOpen(
            params as { workspace_id?: string; tab_id?: string; label?: string }
          )
          break
        case 'plugin.pane.focus':
          result = this.handlePluginPaneFocus(params as { pane_id: string })
          break
        case 'plugin.pane.close':
          result = await this.handlePluginPaneClose(params as { pane_id: string })
          break
        case 'integration.install':
          result = this.handleIntegrationInstall(params as { name: string })
          break
        case 'integration.uninstall':
          result = this.handleIntegrationUninstall(params as { name: string })
          break
        case 'pane.graphics.set':
          result = this.handlePaneGraphicsSet(params as { pane_id: string; protocol?: string })
          break
        case 'pane.graphics.clear':
          result = this.handlePaneGraphicsClear(params as { pane_id: string })
          break
        case 'pane.graphics.info':
          result = this.handlePaneGraphicsInfo(params as { pane_id: string })
          break
        case 'ssh.connect':
          result = await this.handleSshConnect(
            params as {
              host: string
              port?: number
              username?: string
              identityFile?: string
              configHost?: string
            }
          )
          break
        case 'ssh.disconnect':
          result = await this.handleSshDisconnect(params as { connection_id?: string })
          break
        case 'remote.attach':
          result = await this.handleRemoteAttach(
            params as {
              connection_id: string
              cols?: number
              rows?: number
              cwd?: string
              command?: string
            }
          )
          break
        default:
          throw new HerdrRuntimeError('method_not_found', `Method ${method} not found`)
      }

      request.respond(result)
    } catch (error) {
      request.respondError(error)
    }
  }

  private handleApiSchema() {
    return buildHerdrApiSchema()
  }

  private handleWorkspaceCreate(params: {
    label: string
    cwd?: string
    focus?: boolean
    tokens?: Record<string, string>
    worktree?: { checkout_path: string }
  }) {
    const workspace = this.model.ensureWorkspace(params.label, {
      tokens: params.tokens,
      worktree: params.worktree
    })
    const tab = this.model.ensureTab(workspace.workspace_id, 'Terminal')
    const rootPane = this.ensureTabRootPane(workspace.workspace_id, tab.tab_id, params.cwd)
    this.emitEvent('workspace.created', {
      workspace_id: workspace.workspace_id,
      label: workspace.label
    })
    return {
      workspace: {
        workspace_id: workspace.workspace_id,
        label: workspace.label,
        tokens: workspace.tokens,
        worktree: workspace.worktree
      },
      tab: {
        tab_id: tab.tab_id,
        workspace_id: tab.workspace_id,
        label: tab.label
      },
      root_pane: rootPane
    }
  }

  // Why: stock herdr's workspace.create/tab.create spawn a live shell in the
  // root pane; the provider controls that pane directly for single-leaf
  // layouts, so it must exist in the model AND have a running PTY.
  private ensureTabRootPane(
    workspaceId: string,
    tabId: string,
    cwd?: string
  ): {
    pane_id: string
    tab_id: string
    workspace_id: string
    cwd?: string
    label?: string
    agent: string | null
    agent_status: string
    revision: number
  } {
    const tab = this.model.getTab(tabId)
    if (tab?.root.kind === 'pane' && tab.root.pane_id) {
      const existing = this.model.getPane(tab.root.pane_id)
      if (existing) {
        return {
          pane_id: existing.pane_id,
          tab_id: existing.tab_id,
          workspace_id: existing.workspace_id,
          cwd: existing.cwd,
          label: existing.label,
          agent: existing.agent,
          agent_status: existing.agent_status,
          revision: existing.revision
        }
      }
    }
    const paneCwd = cwd ?? this.defaultProtocolCwd()
    const created = this.model.createPane(workspaceId, tabId, { cwd: paneCwd })
    this.spawnProtocolPane(created.pane_id, paneCwd)
    const pane = this.model.getPane(created.pane_id)!
    return {
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      workspace_id: pane.workspace_id,
      cwd: pane.cwd,
      label: pane.label,
      agent: pane.agent,
      agent_status: pane.agent_status,
      revision: pane.revision
    }
  }

  private handleWorkspaceList() {
    return {
      workspaces: this.model.listWorkspaces().map((workspace) => ({
        workspace_id: workspace.workspace_id,
        label: workspace.label
      }))
    }
  }

  // Why: serve the `orca herdr session list` CLI contract (identity-v2 shape)
  // from the protocol-19 model.
  private handleSessionList() {
    const tabs = new Map(this.model.listTabs().map((tab) => [tab.tab_id, tab]))
    return {
      sessionList: [
        {
          sessionName: this.model.sessionName,
          projectId: this.model.sessionName,
          workspaceId: this.model.sessionName,
          panes: this.model.listPanes().map((pane) => ({
            paneId: pane.pane_id,
            leafId: pane.label ?? pane.pane_id,
            title: tabs.get(pane.tab_id)?.label ?? pane.tab_id,
            agent: [
              {
                agent: pane.agent,
                agent_status: pane.agent_status,
                display_agent: pane.agent,
                cwd: pane.cwd,
                focused: tabs.get(pane.tab_id)?.focused_pane_id === pane.pane_id
              }
            ]
          }))
        }
      ]
    }
  }

  private handleWorkspaceGet(params: { workspace_id: string }) {
    const workspace = this.model.getWorkspace(params.workspace_id)
    if (!workspace) {
      throw new HerdrRuntimeError(
        'workspace_not_found',
        `Workspace ${params.workspace_id} not found`
      )
    }
    return workspace
  }

  private handleWorkspaceRename(params: { workspace_id: string; label: string }) {
    this.model.renameWorkspace(params.workspace_id, params.label)
    this.emitEvent('workspace.renamed', {
      workspace_id: params.workspace_id,
      label: params.label
    })
    return { workspace_id: params.workspace_id, label: params.label }
  }

  private handleWorkspaceFocus(params: { workspace_id: string }) {
    if (!this.model.getWorkspace(params.workspace_id)) {
      throw new HerdrRuntimeError(
        'workspace_not_found',
        `Workspace ${params.workspace_id} not found`
      )
    }
    this.emitEvent('workspace.focused', { workspace_id: params.workspace_id })
    return { workspace_id: params.workspace_id }
  }

  private handleWorkspaceClose(params: { workspace_id: string }) {
    this.model.closeWorkspace(params.workspace_id)
    this.emitEvent('workspace.closed', { workspace_id: params.workspace_id })
    return { workspace_id: params.workspace_id }
  }

  private handleTabCreate(params: {
    workspace_id: string
    label: string
    cwd?: string
    focus?: boolean
  }) {
    const tab = this.model.ensureTab(params.workspace_id, params.label)
    const rootPane = this.ensureTabRootPane(tab.workspace_id, tab.tab_id, params.cwd)
    this.emitEvent('tab.created', {
      tab_id: tab.tab_id,
      workspace_id: tab.workspace_id,
      label: tab.label
    })
    return {
      tab: {
        tab_id: tab.tab_id,
        workspace_id: tab.workspace_id,
        label: tab.label
      },
      root_pane: rootPane
    }
  }

  private handleTabList() {
    return {
      tabs: this.model.listTabs().map((tab) => ({
        tab_id: tab.tab_id,
        workspace_id: tab.workspace_id,
        label: tab.label
      }))
    }
  }

  private handleTabGet(params: { tab_id: string }) {
    const tab = this.model.getTab(params.tab_id)
    if (!tab) {
      throw new HerdrRuntimeError('tab_not_found', `Tab ${params.tab_id} not found`)
    }
    return { tab_id: tab.tab_id, workspace_id: tab.workspace_id, label: tab.label }
  }

  private handleTabFocus(params: { tab_id: string }) {
    this.model.focusTab(params.tab_id)
    const tab = this.model.getTab(params.tab_id)
    this.emitEvent('tab.focused', {
      tab_id: params.tab_id,
      workspace_id: tab?.workspace_id ?? null
    })
    return { tab_id: params.tab_id }
  }

  private handleTabRename(params: { tab_id: string; label: string }) {
    this.model.renameTab(params.tab_id, params.label)
    this.emitEvent('tab.renamed', { tab_id: params.tab_id, label: params.label })
    return { tab_id: params.tab_id, label: params.label }
  }

  private handleTabMove(params: { tab_id: string; insert_index: number }) {
    moveTab(this.model, params.tab_id, params.insert_index)
    this.emitEvent('tab.moved', { tab_id: params.tab_id })
    return { tab_id: params.tab_id }
  }

  private handleTabClose(params: { tab_id: string }) {
    const tab = this.model.getTab(params.tab_id)
    if (!tab) {
      throw new HerdrRuntimeError('tab_not_found', `Tab ${params.tab_id} not found`)
    }
    for (const pane of this.model.listPanes()) {
      if (pane.tab_id === params.tab_id) {
        const state = this.protocolPanes.get(pane.pane_id)
        state?.pty.kill()
        this.protocolPanes.delete(pane.pane_id)
      }
    }
    closeTab(this.model, params.tab_id)
    this.emitEvent('tab.closed', {
      tab_id: params.tab_id,
      workspace_id: tab.workspace_id
    })
    return { tab_id: params.tab_id }
  }

  private handleWorkspaceReportMetadata(params: {
    workspace_id: string
    source: string
    tokens?: Record<string, string>
  }) {
    if (!this.model.getWorkspace(params.workspace_id)) {
      throw new HerdrRuntimeError(
        'workspace_not_found',
        `Workspace ${params.workspace_id} not found`
      )
    }
    setWorkspaceMetadata(this.model, params.workspace_id, params.source, params.tokens)
    this.emitEvent('workspace.metadata_updated', { workspace_id: params.workspace_id })
    return { workspace_id: params.workspace_id }
  }

  private handleWorkspaceMove(params: { workspace_id: string; insert_index: number }) {
    moveWorkspace(this.model, params.workspace_id, params.insert_index)
    this.emitEvent('workspace.moved', { workspace_id: params.workspace_id })
    return { workspace_id: params.workspace_id }
  }

  private handleWorkspaceMoveBlock(params: {
    workspace_ids: string[]
    before_workspace_id?: string | null
  }) {
    moveWorkspaceBlock(this.model, params.workspace_ids, params.before_workspace_id ?? null)
    this.emitEvent('workspace.reordered', {
      workspace_ids: params.workspace_ids
    })
    return { workspace_ids: params.workspace_ids }
  }

  private handleWorktreeOpen(params: {
    path?: string
    branch?: string
    label?: string
    focus?: boolean
    base?: string
    cwd?: string
  }) {
    const checkoutPath = params.path
    if (!checkoutPath) {
      throw new HerdrRuntimeError('invalid_params', 'worktree.open requires a --path')
    }
    const label = params.label ?? checkoutPath.split(/[\\/]/).pop() ?? 'worktree'
    const alreadyOpen = this.model.getWorkspaceByLabel(label) !== undefined
    const workspace = this.model.ensureWorkspace(label)
    setWorkspaceWorktree(this.model, workspace.workspace_id, {
      checkout_path: checkoutPath,
      repo_key: `repo:${checkoutPath}`,
      repo_name: label,
      repo_root: params.base ?? checkoutPath,
      is_linked_worktree: params.branch !== undefined
    })
    const tab = this.model.ensureTab(workspace.workspace_id, 'Terminal')
    const rootPane = this.ensureTabRootPane(workspace.workspace_id, tab.tab_id, params.cwd)
    this.emitEvent('worktree.opened', {
      workspace_id: workspace.workspace_id,
      checkout_path: checkoutPath
    })
    return {
      workspace: {
        workspace_id: workspace.workspace_id,
        label: workspace.label,
        tokens: workspace.tokens,
        worktree: workspace.worktree
      },
      tab: {
        tab_id: tab.tab_id,
        workspace_id: tab.workspace_id,
        label: tab.label
      },
      root_pane: rootPane,
      already_open: alreadyOpen
    }
  }

  private handleWorktreeList() {
    const worktrees = this.model
      .listWorkspaces()
      .filter((workspace) => workspace.worktree)
      .map((workspace) => ({
        workspace_id: workspace.workspace_id,
        label: workspace.label,
        worktree: {
          repo_key: workspace.worktree?.repo_key ?? `repo:${workspace.worktree?.checkout_path}`,
          repo_name: workspace.worktree?.repo_name ?? workspace.label,
          repo_root: workspace.worktree?.repo_root ?? workspace.worktree?.checkout_path ?? '',
          checkout_path: workspace.worktree?.checkout_path ?? '',
          is_linked_worktree: workspace.worktree?.is_linked_worktree ?? false
        }
      }))
    return { worktrees }
  }

  private handleWorktreeRemove(params: { workspace_id: string }) {
    if (!this.model.getWorkspace(params.workspace_id)) {
      throw new HerdrRuntimeError(
        'workspace_not_found',
        `Workspace ${params.workspace_id} not found`
      )
    }
    for (const pane of this.model.listPanes()) {
      if (pane.workspace_id === params.workspace_id) {
        const state = this.protocolPanes.get(pane.pane_id)
        state?.pty.kill()
        this.protocolPanes.delete(pane.pane_id)
      }
    }
    this.model.closeWorkspace(params.workspace_id)
    this.emitEvent('worktree.removed', { workspace_id: params.workspace_id })
    return { workspace_id: params.workspace_id }
  }

  private handlePaneNeighbor(params: {
    direction: 'left' | 'right' | 'up' | 'down'
    pane_id?: string | null
  }) {
    const paneId = params.pane_id ?? this.focusedProtocolPane()?.pane_id
    if (!paneId) {
      throw new HerdrRuntimeError('pane_not_found', 'No focused pane')
    }
    const pane = this.model.getPane(paneId)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${paneId} not found`)
    }
    const tab = this.model.getTab(pane.tab_id)
    const neighbor = tab ? paneNeighbor(tab.root, paneId, params.direction, DEFAULT_AREA) : null
    return {
      direction: params.direction,
      neighbor_pane_id: neighbor,
      pane_id: paneId,
      layout: herdrLayoutSnapshot(this.model, pane.tab_id)
    }
  }

  private handlePaneEdges(params: { pane_id?: string | null }) {
    const paneId = params.pane_id ?? this.focusedProtocolPane()?.pane_id
    if (!paneId) {
      throw new HerdrRuntimeError('pane_not_found', 'No focused pane')
    }
    const pane = this.model.getPane(paneId)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${paneId} not found`)
    }
    const tab = this.model.getTab(pane.tab_id)
    const edges = tab
      ? paneEdges(tab.root, paneId, DEFAULT_AREA)
      : { left: false, right: false, up: false, down: false }
    return {
      pane_id: paneId,
      ...edges,
      layout: herdrLayoutSnapshot(this.model, pane.tab_id)
    }
  }

  private handlePaneSwap(params: {
    pane_id?: string | null
    source_pane_id?: string | null
    target_pane_id?: string | null
    direction?: 'left' | 'right' | 'up' | 'down'
  }) {
    const sourceId = params.source_pane_id ?? params.pane_id ?? this.focusedProtocolPane()?.pane_id
    if (!sourceId) {
      throw new HerdrRuntimeError('pane_not_found', 'No source pane')
    }
    const targetId =
      params.target_pane_id ??
      (params.direction ? this.paneNeighborId(sourceId, params.direction) : null)
    if (!targetId) {
      throw new HerdrRuntimeError('pane_not_found', 'No target pane')
    }
    swapPanes(this.model, sourceId, targetId)
    this.emitEvent('pane.moved', { pane_id: sourceId })
    const tab = this.model.getTab(this.model.getPane(sourceId)?.tab_id ?? '')
    return {
      changed: true,
      source_pane_id: sourceId,
      target_pane_id: targetId,
      focused_pane_id: tab?.focused_pane_id ?? sourceId,
      layout: herdrLayoutSnapshot(
        this.model,
        this.model.getPane(sourceId)?.tab_id ?? this.model.getPane(targetId)?.tab_id ?? ''
      )
    }
  }

  private handlePaneMove(params: {
    pane_id: string
    destination: {
      type: 'tab' | 'new_tab' | 'new_workspace'
      tab_id?: string
      split?: 'right' | 'down'
      target_pane_id?: string
      ratio?: number
      workspace_id?: string
      label?: string
      tab_label?: string
    }
    focus?: boolean
  }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    const detached = this.model.detachPane(params.pane_id)
    let createdTab: { tab_id: string; workspace_id: string; label: string } | null = null
    let createdWorkspace: { workspace_id: string; label: string } | null = null

    if (params.destination.type === 'tab') {
      const targetPaneId = params.destination.target_pane_id
      if (targetPaneId && this.model.getPane(targetPaneId)) {
        this.model.attachPaneAsSplit(
          params.pane_id,
          targetPaneId,
          params.destination.split ?? 'right',
          params.destination.ratio ?? 0.5
        )
      } else {
        const tabId = params.destination.tab_id
        if (!tabId) {
          throw new HerdrRuntimeError(
            'invalid_params',
            'pane.move tab destination requires tab_id or target_pane_id'
          )
        }
        const tab = this.model.getTab(tabId)
        if (!tab) {
          throw new HerdrRuntimeError('tab_not_found', `Tab ${tabId} not found`)
        }
        this.model.attachPaneToTab(params.pane_id, tab.workspace_id, tabId)
      }
    } else if (params.destination.type === 'new_tab') {
      const workspaceId = params.destination.workspace_id ?? detached.previous_workspace_id
      if (!this.model.getWorkspace(workspaceId)) {
        throw new HerdrRuntimeError('workspace_not_found', `Workspace ${workspaceId} not found`)
      }
      const tab = this.model.ensureTab(workspaceId, params.destination.label ?? 'tab')
      this.model.attachPaneToTab(params.pane_id, workspaceId, tab.tab_id)
      createdTab = { tab_id: tab.tab_id, workspace_id: workspaceId, label: tab.label }
    } else {
      const workspace = this.model.ensureWorkspace(params.destination.label ?? 'workspace')
      const tab = this.model.ensureTab(
        workspace.workspace_id,
        params.destination.tab_label ?? 'default'
      )
      this.model.attachPaneToTab(params.pane_id, workspace.workspace_id, tab.tab_id)
      createdWorkspace = { workspace_id: workspace.workspace_id, label: workspace.label }
      createdTab = { tab_id: tab.tab_id, workspace_id: workspace.workspace_id, label: tab.label }
    }

    if (params.focus !== false) {
      this.model.focusPane(params.pane_id)
    }
    this.emitEvent('pane.moved', { pane_id: params.pane_id })
    this.emitEvent('layout.updated', {
      pane_id: params.pane_id,
      tab_id: this.model.getPane(params.pane_id)?.tab_id
    })
    return {
      changed: true,
      pane_id: params.pane_id,
      previous_pane_id: params.pane_id,
      previous_tab_id: detached.previous_tab_id,
      previous_workspace_id: detached.previous_workspace_id,
      focused_pane_id: params.pane_id,
      created_tab: createdTab,
      created_workspace: createdWorkspace,
      closed_tab_id: detached.closed_tab_id,
      closed_workspace_id: detached.closed_workspace_id
    }
  }

  private handlePaneFocusDirection(params: {
    direction: 'left' | 'right' | 'up' | 'down'
    pane_id?: string | null
  }) {
    const sourceId = params.pane_id ?? this.focusedProtocolPane()?.pane_id
    if (!sourceId) {
      throw new HerdrRuntimeError('pane_not_found', 'No focused pane')
    }
    const neighbor = this.paneNeighborId(sourceId, params.direction)
    if (!neighbor) {
      return {
        changed: false,
        focused_pane_id: sourceId,
        pane_id: null
      }
    }
    this.model.focusPane(neighbor)
    this.emitEvent('pane.focused', { pane_id: neighbor })
    return {
      changed: true,
      focused_pane_id: neighbor,
      pane_id: neighbor
    }
  }

  private paneNeighborId(
    paneId: string,
    direction: 'left' | 'right' | 'up' | 'down'
  ): string | null {
    const pane = this.model.getPane(paneId)
    if (!pane) {
      return null
    }
    const tab = this.model.getTab(pane.tab_id)
    return tab ? paneNeighbor(tab.root, paneId, direction, DEFAULT_AREA) : null
  }

  private handlePaneFocus(params: { pane_id: string }) {
    this.model.focusPane(params.pane_id)
    this.emitEvent('pane.focused', { pane_id: params.pane_id })
    return { pane_id: params.pane_id }
  }

  private handlePaneList() {
    return {
      panes: this.model.listPanes().map((pane) => this.protocolPaneInfo(pane))
    }
  }

  private handlePaneCurrent() {
    const focused = this.focusedProtocolPane()
    if (!focused) {
      return { pane: null }
    }
    return { pane: this.protocolPaneInfo(focused) }
  }

  private handlePaneGet(params: { pane_id: string }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    return { pane: this.protocolPaneInfo(pane) }
  }

  private handleLayoutExport(params: { pane_id?: string | null; tab_id?: string | null }) {
    const paneId = params.pane_id
    const tab = paneId
      ? this.model.getPane(paneId)?.tab_id
      : (params.tab_id ?? this.model.listTabs()[0]?.tab_id)
    if (!tab) {
      throw new HerdrRuntimeError('tab_not_found', 'No tab to export')
    }
    return { root: herdrExportLayout(this.model, tab) }
  }

  private handleLayoutSetSplitRatio(params: {
    pane_id?: string | null
    path?: boolean[]
    ratio: number
    tab_id?: string | null
  }) {
    let tabId: string | null | undefined
    if (params.pane_id) {
      this.model.setSplitRatio(params.pane_id, params.ratio)
      tabId = this.model.getPane(params.pane_id)?.tab_id
    } else if (params.path && params.tab_id) {
      this.model.setSplitRatioByPath(params.tab_id, params.path, params.ratio)
      tabId = params.tab_id
    } else {
      throw new HerdrRuntimeError(
        'invalid_params',
        'layout.set_split_ratio requires pane_id or path + tab_id'
      )
    }
    if (!tabId) {
      throw new HerdrRuntimeError('tab_not_found', 'No tab to snapshot')
    }
    this.emitEvent('layout.updated', { tab_id: tabId })
    return { layout: herdrLayoutSnapshot(this.model, tabId) }
  }

  private async handleLayoutApply(params: {
    root: LayoutNode
    focus?: boolean
    tab_id?: string | null
    tab_label?: string | null
    workspace_id?: string | null
    workspace_label?: string | null
  }): Promise<{ layout: unknown; tab_id: string; workspace_id: string }> {
    const workspace = params.workspace_id
      ? (this.model.getWorkspace(params.workspace_id) ??
        this.model.ensureWorkspace(params.workspace_id))
      : this.model.ensureWorkspace(params.workspace_label ?? 'default')
    const tab = this.model.ensureTab(workspace.workspace_id, params.tab_label ?? 'default')

    for (const pane of this.model
      .listPanes()
      .filter((candidate) => candidate.tab_id === tab.tab_id)) {
      this.protocolPanes.get(pane.pane_id)?.pty.kill()
      this.protocolPanes.delete(pane.pane_id)
    }

    const created = this.model.applyLayout(
      workspace.workspace_id,
      tab.tab_id,
      params.root,
      this.defaultProtocolCwd()
    )
    for (const paneId of created) {
      const pane = this.model.getPane(paneId)
      if (pane) {
        this.spawnProtocolPane(paneId, pane.cwd)
      }
      this.emitEvent('pane.created', { pane_id: paneId })
    }
    this.emitEvent('layout.updated', { tab_id: tab.tab_id, workspace_id: workspace.workspace_id })
    if (params.focus && created.length > 0) {
      this.model.focusPane(created[0])
      this.emitEvent('pane.focused', { pane_id: created[0] })
    }
    return {
      layout: {
        ...herdrLayoutSnapshot(this.model, tab.tab_id),
        // Why: the provider's applyTabLayout walks layout.root to map Orca
        // leafs to the created panes in tree order; without it, reconciliation
        // falls back to pane.split replay, which needs live panes it never
        // created.
        root: herdrExportLayout(this.model, tab.tab_id)
      },
      tab_id: tab.tab_id,
      workspace_id: workspace.workspace_id
    }
  }

  private focusedProtocolPane(): ModelPane | null {
    const focusedTab = this.model.listTabs().find((tab) => tab.focused_pane_id)
    if (focusedTab?.focused_pane_id) {
      return this.model.getPane(focusedTab.focused_pane_id) ?? null
    }
    const first = this.model.listTabs()[0]
    if (first?.focused_pane_id) {
      return this.model.getPane(first.focused_pane_id) ?? null
    }
    return null
  }

  private protocolPaneInfo(pane: ModelPane) {
    const state = this.protocolPanes.get(pane.pane_id)
    return {
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      workspace_id: pane.workspace_id,
      cwd: pane.cwd,
      label: pane.label,
      tokens: pane.tokens,
      agent: pane.agent,
      agent_status: pane.agent_status,
      revision: state?.sequence ?? pane.revision,
      cols: state?.cols,
      rows: state?.rows
    }
  }

  // Why: serve the `orca herdr pane create` CLI contract (identity-v2 shape)
  // on top of the protocol-19 model. Idempotent per target: a second create
  // against the same tab/leaf returns the live pane instead of duplicating it.
  private async handlePaneCreate(params: {
    target: { project: string; workspace: string; tab: string; leaf: string }
    options: {
      cols: number
      rows: number
      cwd?: string
      env?: Record<string, string>
      command?: string
      launchAgent?: string
    }
  }): Promise<{
    paneId: string
    identity: {
      version: number
      projectId: string
      workspaceId: string
      tabId: string
      leafId: string
      paneId: string
    }
    isReattach: boolean
    snapshot?: string
    snapshotCols?: number
    snapshotRows?: number
  }> {
    const { target, options } = params
    const { project, workspace, tab, leaf } = target

    const identity = {
      version: 2,
      projectId: project,
      workspaceId: workspace,
      tabId: tab,
      leafId: leaf,
      paneId: ''
    }

    const modelWorkspace = this.model.ensureWorkspace(`${project}/${workspace}`)
    const modelTab = this.model.ensureTab(modelWorkspace.workspace_id, tab)

    if (modelTab.root.kind === 'pane' && modelTab.root.pane_id) {
      const existing = modelTab.root.pane_id
      return {
        paneId: existing,
        identity: { ...identity, paneId: existing },
        isReattach: true
      }
    }

    const cwd = options.cwd ?? this.defaultProtocolCwd()
    const created = this.model.createPane(modelWorkspace.workspace_id, modelTab.tab_id, {
      cwd,
      label: leaf
    })
    identity.paneId = created.pane_id

    this.spawnProtocolPane(created.pane_id, cwd)
    const state = this.protocolPanes.get(created.pane_id)
    if (state) {
      state.cols = options.cols
      state.rows = options.rows
      state.pty.resize(options.cols, options.rows)
    }

    for (const [key, value] of Object.entries({
      ...options.env,
      ...this.agentEnvFor(options.launchAgent)
    })) {
      state?.pty.write(`export ${key}=${JSON.stringify(value)}\r`)
    }
    if (options.command) {
      state?.pty.write(`${options.command}\r`)
    }

    this.emitEvent('pane.created', { pane_id: created.pane_id })

    return {
      paneId: created.pane_id,
      identity,
      isReattach: false,
      snapshot: '',
      snapshotCols: options.cols,
      snapshotRows: options.rows
    }
  }

  private agentEnvFor(launchAgent: string | undefined): Record<string, string> {
    return launchAgent ? getAgentEnv(launchAgent) : {}
  }

  private defaultProtocolCwd(): string {
    return process.env.HOME ?? process.cwd()
  }

  private spawnProtocolPane(paneId: string, cwd: string): void {
    const shell = getDefaultShell()
    const ptyInstance = this.spawnPty({
      cwd,
      cols: 120,
      rows: 30,
      env: this.protocolEnv(),
      shell,
      shellArgs: getDefaultShellArgs(shell),
      ptyPath: getPanePtyPath(paneId)
    })
    const state: ProtocolPaneState = {
      pty: ptyInstance,
      buffer: '',
      sequence: 0,
      cols: 120,
      rows: 30
    }
    this.protocolPanes.set(paneId, state)
    this.model.bumpPaneRevision(paneId)

    ptyInstance.onData((data: string) => {
      state.buffer += data
      state.sequence += 1
      this.model.bumpPaneRevision(paneId)
      this.emitPaneData(paneId, data, state.sequence)
      this.detectPaneAgent(paneId, state)
    })

    ptyInstance.onExit(({ exitCode, signal }) => {
      const code = signal ? 128 + signal : exitCode
      this.emitPaneExit(paneId, code)
    })
  }

  private detectPaneAgent(paneId: string, state: ProtocolPaneState): void {
    const pane = this.model.getPane(paneId)
    if (!pane || pane.agent) {
      return
    }
    // Why: scan every 10th chunk so detection is cheap; agents announce early.
    if (state.sequence % 10 !== 0) {
      return
    }
    const agent = detectAgentFromBuffer(state.buffer)
    if (agent) {
      this.model.setPaneAgent(paneId, agent)
      this.model.setPaneAgentStatus(paneId, 'working')
      this.emitEvent('pane.agent_detected', {
        pane_id: paneId,
        agent,
        agent_status: 'working'
      })
      this.emitEvent('pane.agent_status_changed', {
        pane_id: paneId,
        agent,
        agent_status: 'working'
      })
    }
  }

  private emitAgentStatus(paneId: string, agent: string | null, status: string): void {
    this.emitEvent('pane.agent_status_changed', {
      pane_id: paneId,
      agent,
      agent_status: status
    })
  }

  private protocolEnv(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Orca',
      TERM_PROGRAM_VERSION: process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
      FORCE_HYPERLINK: '1',
      LANG: 'en_US.UTF-8',
      HERDR_SESSION: 'orca'
    }
  }

  private spawnPty(options: {
    cwd: string
    cols: number
    rows: number
    env: Record<string, string>
    shell: string
    shellArgs: string[]
    ptyPath: string
  }): pty.IPty {
    const { cwd, cols, rows, env, shell, shellArgs } = options

    const ptyOptions: pty.IPtyForkOptions = {
      cwd,
      cols,
      rows,
      env: {
        ...env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'Orca',
        TERM_PROGRAM_VERSION: process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
        FORCE_HYPERLINK: '1'
      },
      name: 'xterm-256color',
      handleFlowControl: true
    }

    if (platform === 'win32') {
      return pty.spawn(shell, shellArgs, {
        ...ptyOptions,
        useConpty: true
      })
    }
    return pty.spawn(shell, shellArgs, ptyOptions)
  }

  private async handlePaneSplit(params: {
    pane_id: string
    direction: 'right' | 'down'
    ratio?: number
  }): Promise<{ pane_id: string }> {
    const { pane_id } = params

    const protocolSource = this.model.getPane(pane_id)
    if (protocolSource && this.protocolPanes.has(pane_id)) {
      const created = this.model.splitPane(pane_id, params.direction, params.ratio, {
        cwd: protocolSource.cwd,
        label: protocolSource.label
      })
      this.spawnProtocolPane(created.pane_id, protocolSource.cwd)
      this.emitEvent('pane.created', { pane_id: created.pane_id })
      this.emitEvent('layout.updated', { tab_id: protocolSource.tab_id })
      return { pane_id: created.pane_id }
    }

    throw new HerdrRuntimeError('pane_not_found', `Pane ${pane_id} not found`)
  }

  private async handlePaneResize(params: {
    pane_id: string
    cols?: number
    rows?: number
    direction?: 'left' | 'right' | 'up' | 'down'
    amount?: number
  }): Promise<void> {
    const { pane_id } = params

    // Why: both stock wire shapes are in use — the terminal controller sends
    // absolute cols/rows, the pane resize shortcuts send direction+amount.
    const nextSize = (currentCols: number, currentRows: number) => {
      let cols = params.cols ?? currentCols
      let rows = params.rows ?? currentRows
      if (params.direction && params.amount) {
        const amount = Math.max(0, Math.round(params.amount))
        if (params.direction === 'left') {
          cols = Math.max(1, currentCols - amount)
        } else if (params.direction === 'right') {
          cols = currentCols + amount
        } else if (params.direction === 'up') {
          rows = Math.max(1, currentRows - amount)
        } else if (params.direction === 'down') {
          rows = currentRows + amount
        }
      }
      return { cols, rows }
    }

    const protocol = this.protocolPanes.get(pane_id)
    if (protocol) {
      const { cols, rows } = nextSize(protocol.cols, protocol.rows)
      protocol.cols = cols
      protocol.rows = rows
      protocol.pty.resize(cols, rows)
      this.emitEvent('pane.updated', { pane_id, cols, rows })
      this.emitEvent('pane.scroll_changed', { pane_id })
      return
    }

    const remote = this.remotePanes.get(pane_id)
    if (remote) {
      const { cols, rows } = nextSize(remote.cols, remote.rows)
      remote.cols = cols
      remote.rows = rows
      remote.channel.setWindow(rows, cols, rows, cols)
      this.emitEvent('pane.updated', { pane_id, cols, rows })
      this.emitEvent('pane.scroll_changed', { pane_id })
      return
    }

    throw new HerdrRuntimeError('pane_not_found', `Pane ${pane_id} not found`)
  }

  private async handlePaneClose(params: { pane_id: string }): Promise<void> {
    const { pane_id } = params

    const protocol = this.protocolPanes.get(pane_id)
    if (protocol) {
      protocol.pty.kill()
      this.protocolPanes.delete(pane_id)
      this.model.closePane(pane_id)
      this.emitEvent('pane.closed', { pane_id })
      return
    }

    const remote = this.remotePanes.get(pane_id)
    if (remote) {
      try {
        remote.channel.close()
      } catch {
        // Why: the channel may have already closed.
      }
      this.remotePanes.delete(pane_id)
      this.model.closePane(pane_id)
      this.emitEvent('pane.closed', { pane_id })
      return
    }

    throw new HerdrRuntimeError('pane_not_found', `Pane ${pane_id} not found`)
  }

  private handlePaneCwd(params: { pane_id: string }): string {
    const modelPane = this.model.getPane(params.pane_id)
    if (modelPane) {
      return modelPane.cwd
    }
    throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
  }

  private async handlePaneSendKeys(params: { pane_id: string; keys: string[] }): Promise<void> {
    const { pane_id, keys } = params

    const protocol = this.protocolPanes.get(pane_id)
    if (protocol) {
      for (const key of keys) {
        protocol.pty.write(key)
      }
      return
    }

    const remote = this.remotePanes.get(pane_id)
    if (remote) {
      for (const key of keys) {
        remote.channel.write(key)
      }
      return
    }

    throw new HerdrRuntimeError('pane_not_found', `Pane ${pane_id} not found`)
  }

  private async handleProtocolPaneSend(params: { pane_id: string; text: string }): Promise<{
    pane_id: string
    sequence: number
  }> {
    const state = this.protocolPanes.get(params.pane_id)
    if (state) {
      state.pty.write(params.text)
      return { pane_id: params.pane_id, sequence: state.sequence }
    }
    const remote = this.remotePanes.get(params.pane_id)
    if (remote) {
      remote.channel.write(params.text)
      return { pane_id: params.pane_id, sequence: remote.sequence }
    }
    throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
  }

  private async handleProtocolPaneSendInput(params: {
    pane_id: string
    keys?: string[]
    text?: string
  }): Promise<{ pane_id: string; sequence: number }> {
    const state = this.protocolPanes.get(params.pane_id)
    if (state) {
      for (const key of params.keys ?? []) {
        state.pty.write(key)
      }
      if (params.text) {
        state.pty.write(params.text)
      }
      return { pane_id: params.pane_id, sequence: state.sequence }
    }
    const remote = this.remotePanes.get(params.pane_id)
    if (remote) {
      for (const key of params.keys ?? []) {
        remote.channel.write(key)
      }
      if (params.text) {
        remote.channel.write(params.text)
      }
      return { pane_id: params.pane_id, sequence: remote.sequence }
    }
    throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
  }

  private handleProtocolPaneRead(params: {
    pane_id: string
    format?: 'text' | 'ansi'
    lines?: number | null
    source: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'
    strip_ansi?: boolean
  }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    const state = this.protocolPanes.get(params.pane_id) ?? this.remotePanes.get(params.pane_id)
    if (!state) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} has no PTY state`)
    }
    return {
      type: 'pane_read' as const,
      read: buildPaneReadResult({
        pane_id: params.pane_id,
        workspace_id: pane.workspace_id,
        tab_id: pane.tab_id,
        buffer: state.buffer,
        revision: state.sequence,
        rows: state.rows,
        params
      })
    }
  }

  private async handleProtocolPaneWaitForOutput(params: {
    pane_id: string
    match?: { type: 'substring' | 'regex'; value: string }
    lines?: number | null
    timeout_ms?: number
    revision?: number
  }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    const state = this.protocolPanes.get(params.pane_id) ?? this.remotePanes.get(params.pane_id)
    if (!state) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} has no PTY state`)
    }
    const timeoutMs = Math.max(0, params.timeout_ms ?? 10_000)
    const deadline = Date.now() + timeoutMs
    const initialRevision = params.revision ?? state.sequence
    const regex = params.match?.type === 'regex' ? new RegExp(params.match.value) : null
    const substring = params.match?.type === 'substring' ? params.match.value : null
    const hasMatch = Boolean(params.match)

    while (Date.now() < deadline) {
      if (substring && state.buffer.includes(substring)) {
        break
      }
      if (regex && regex.test(stripAnsiEscape(state.buffer))) {
        break
      }
      if (
        !hasMatch &&
        (params.revision === undefined
          ? state.sequence > initialRevision
          : state.sequence > params.revision)
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const read = buildPaneReadResult({
      pane_id: params.pane_id,
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      buffer: state.buffer,
      revision: state.sequence,
      rows: state.rows,
      params: {
        pane_id: params.pane_id,
        source: 'recent',
        lines: params.lines ?? 100,
        format: 'text',
        strip_ansi: true
      }
    })
    const matchedLine = matchedLineFor(state.buffer, params.match)
    if (params.match && matchedLine) {
      this.emitEvent('pane.output_matched', {
        pane_id: params.pane_id,
        matched_line: matchedLine,
        revision: state.sequence
      })
    }
    return {
      pane_id: params.pane_id,
      matched_line: matchedLine,
      revision: state.sequence,
      read
    }
  }

  private handleProtocolPaneRename(params: { pane_id: string; label: string }) {
    this.model.renamePane(params.pane_id, params.label)
    this.emitEvent('pane.updated', { pane_id: params.pane_id, label: params.label })
    return { pane_id: params.pane_id, label: params.label }
  }

  private handleProtocolPaneProcessInfo(params: { pane_id: string }) {
    const state = this.protocolPanes.get(params.pane_id)
    if (state) {
      return {
        process_info: {
          shell_pid: state.pty.pid,
          foreground_processes: []
        }
      }
    }
    const remote = this.remotePanes.get(params.pane_id)
    if (remote) {
      return {
        process_info: {
          shell_pid: undefined,
          foreground_processes: []
        }
      }
    }
    throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
  }

  private handleProtocolPaneLayout(params: { pane_id: string }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    return { layout: herdrLayoutSnapshot(this.model, pane.tab_id) }
  }

  private handleProtocolPaneZoom(params: { pane_id: string }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    const tab = this.model.listTabs().find((candidate) => candidate.tab_id === pane.tab_id)
    const zoomed = tab ? !tab.zoomed : false
    this.model.setPaneZoomed(params.pane_id, zoomed)
    this.emitEvent('layout.updated', { tab_id: pane.tab_id })
    return {
      changed: true,
      zoom_changed: true,
      focus_changed: false,
      pane_id: params.pane_id,
      focused_pane_id: pane.pane_id,
      zoomed,
      layout: herdrLayoutSnapshot(this.model, pane.tab_id)
    }
  }

  private handleProtocolPaneReportMetadata(params: {
    pane_id: string
    tokens?: Record<string, string>
    source?: string
    metadata?: Record<string, unknown>
  }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    if (params.tokens) {
      this.model.setPaneTokens(params.pane_id, params.tokens)
    }
    const state = this.protocolPanes.get(params.pane_id)
    if (state) {
      ;(state as ProtocolPaneState & { metadata?: Record<string, unknown> }).metadata = {
        ...(params.source ? { source: params.source } : {}),
        ...params.tokens
      }
    }
    return { pane_id: params.pane_id, accepted: true }
  }

  private handleProtocolPaneReportAgent(params: { pane_id: string; agent: string }) {
    this.model.setPaneAgent(params.pane_id, params.agent)
    this.model.setPaneAgentStatus(params.pane_id, 'working')
    this.emitEvent('pane.agent_detected', {
      pane_id: params.pane_id,
      agent: params.agent,
      agent_status: 'working'
    })
    this.emitAgentStatus(params.pane_id, params.agent, 'working')
    return {
      pane_id: params.pane_id,
      agent: params.agent,
      agent_status: 'working'
    }
  }

  private handleProtocolPaneReportAgentSession(params: {
    pane_id: string
    agent: string
    agent_session?: string
  }) {
    this.model.setPaneAgent(params.pane_id, params.agent)
    this.model.setPaneAgentStatus(params.pane_id, 'working')
    this.emitAgentStatus(params.pane_id, params.agent, 'working')
    return {
      pane_id: params.pane_id,
      agent: params.agent,
      agent_session: params.agent_session ?? null,
      agent_status: 'working'
    }
  }

  private handleProtocolPaneReleaseAgent(params: { pane_id: string }) {
    this.model.setPaneAgent(params.pane_id, null)
    this.model.setPaneAgentStatus(params.pane_id, 'idle')
    this.emitAgentStatus(params.pane_id, null, 'idle')
    return { pane_id: params.pane_id, agent: null, agent_status: 'idle' }
  }

  private handleProtocolPaneClearAgentAuthority(params: { pane_id: string }) {
    this.model.setPaneAgent(params.pane_id, null)
    this.model.setPaneAgentStatus(params.pane_id, 'idle')
    this.emitAgentStatus(params.pane_id, null, 'idle')
    return { pane_id: params.pane_id, agent: null, agent_status: 'idle' }
  }

  // Why: agents in the in-app daemon are panes with an attached agent identity.
  // target resolves to a pane by id, then by agent name, mirroring stock herdr.

  private resolveAgentTarget(target: string): ModelPane {
    const byId = this.model.getPane(target)
    if (byId) {
      return byId
    }
    const byName = this.model.listPanes().find((pane) => pane.agent === target)
    if (byName) {
      return byName
    }
    throw new HerdrRuntimeError('agent_not_found', `Agent ${target} not found`)
  }

  private agentState(pane: ModelPane) {
    return {
      agent: pane.agent,
      agent_status: pane.agent_status,
      interactive_ready: pane.agent_status === 'idle' && pane.agent !== null,
      launch_pending: false,
      display_agent: pane.agent,
      name: pane.label ?? pane.agent,
      pane_id: pane.pane_id
    }
  }

  private handleAgentList() {
    const agents = this.model
      .listPanes()
      .filter((pane) => this.protocolPanes.has(pane.pane_id))
      .map((pane) => this.agentState(pane))
    return { agents }
  }

  private handleAgentGet(params: { target: string }) {
    return this.agentState(this.resolveAgentTarget(params.target))
  }

  private async handleAgentWait(params: { target: string; until: string[]; timeout_ms?: number }) {
    const pane = this.resolveAgentTarget(params.target)
    const until = new Set(params.until ?? [])
    const timeoutMs = Math.max(0, params.timeout_ms ?? 10_000)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const current = this.model.getPane(pane.pane_id)
      if (current && until.has(current.agent_status)) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const final = this.model.getPane(pane.pane_id) ?? pane
    return { agent: this.agentState(final) }
  }

  private handleAgentRead(params: {
    target: string
    source?: string
    lines?: number | null
    strip_ansi?: boolean
    format?: 'text' | 'ansi'
  }) {
    const pane = this.resolveAgentTarget(params.target)
    return this.handleProtocolPaneRead({
      pane_id: pane.pane_id,
      source:
        (params.source as 'visible' | 'recent' | 'recent_unwrapped' | 'detection') ?? 'recent',
      lines: params.lines ?? null,
      strip_ansi: params.strip_ansi ?? true,
      format: params.format ?? 'text'
    })
  }

  private handleAgentRename(params: { target: string; name: string }) {
    const pane = this.resolveAgentTarget(params.target)
    this.model.renamePane(pane.pane_id, params.name)
    this.emitEvent('pane.updated', { pane_id: pane.pane_id, label: params.name })
    return { target: params.target, name: params.name, pane_id: pane.pane_id }
  }

  private handleAgentFocus(params: { target: string }) {
    const pane = this.resolveAgentTarget(params.target)
    this.model.focusPane(pane.pane_id)
    this.emitEvent('pane.focused', { pane_id: pane.pane_id })
    return { pane_id: pane.pane_id }
  }

  private handleAgentExplain(params: { target: string }) {
    const pane = this.resolveAgentTarget(params.target)
    const manifest = pane.agent ? findAgentManifest(pane.agent) : undefined
    if (!pane.agent) {
      return {
        agent: null,
        final_state: pane.agent_status,
        skip_reason: 'no_agent'
      }
    }
    return {
      agent: pane.agent,
      final_state: pane.agent_status,
      manifest: manifest ? { source: manifest.source, version: manifest.version } : undefined
    }
  }

  private async handleAgentStart(params: {
    name: string
    kind: string
    pane_id: string
    args?: string[]
    timeout_ms?: number
  }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    const state = this.protocolPanes.get(params.pane_id)
    if (!state) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} has no PTY state`)
    }
    this.model.setPaneAgent(params.pane_id, params.name)
    this.model.setPaneAgentStatus(params.pane_id, 'working')
    const agentEnv = getAgentEnv(params.name)
    for (const [key, value] of Object.entries(agentEnv)) {
      state.pty.write(`export ${key}=${JSON.stringify(value)}\r`)
    }
    const command = [params.name, ...(params.args ?? [])].join(' ')
    state.pty.write(`${command}\r`)
    this.emitEvent('pane.agent_detected', {
      pane_id: params.pane_id,
      agent: params.name,
      agent_status: 'working'
    })
    this.emitAgentStatus(params.pane_id, params.name, 'working')
    if (params.timeout_ms) {
      const until = new Set(['idle', 'done'])
      const deadline = Date.now() + params.timeout_ms
      while (Date.now() < deadline) {
        const current = this.model.getPane(params.pane_id)
        if (current && until.has(current.agent_status)) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    return { pane_id: params.pane_id, agent: params.name, kind: params.kind }
  }

  private async handleAgentPrompt(params: {
    target: string
    text: string
    wait?: boolean
    until?: string[]
    timeout_ms?: number
  }) {
    const pane = this.resolveAgentTarget(params.target)
    const state = this.protocolPanes.get(pane.pane_id)
    if (!state) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${pane.pane_id} has no PTY state`)
    }
    state.pty.write(`${params.text}\r`)
    if (params.wait) {
      const until = new Set(params.until ?? ['done', 'idle'])
      const timeoutMs = Math.max(0, params.timeout_ms ?? 10_000)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const current = this.model.getPane(pane.pane_id)
        if (current && until.has(current.agent_status)) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    return { pane_id: pane.pane_id, sequence: state.sequence }
  }

  private async handleAgentSendKeys(params: { target: string; keys: string[] }) {
    const pane = this.resolveAgentTarget(params.target)
    const state = this.protocolPanes.get(pane.pane_id)
    if (!state) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${pane.pane_id} has no PTY state`)
    }
    for (const key of params.keys) {
      state.pty.write(key)
    }
    return { pane_id: pane.pane_id, sequence: state.sequence }
  }

  private handleAgentViewSet(params: {
    source: string
    label?: string | null
    filter?: unknown
    sort?: unknown[]
  }) {
    this.agentView = {
      source: params.source,
      label: params.label ?? null,
      filter: params.filter,
      sort: params.sort
    }
    return { source: params.source, label: params.label ?? null }
  }

  private handleAgentViewClear(params: { source?: string | null }) {
    if (!params.source || this.agentView?.source === params.source) {
      this.agentView = null
    }
    return { cleared: true }
  }

  private handleServerAgentManifests() {
    return { manifests: HERDR_AGENT_MANIFESTS }
  }

  private handleServerReloadAgentManifests() {
    return { reloaded: true, count: HERDR_AGENT_MANIFESTS.length }
  }

  // Why: the in-app daemon already owns the live session, so live_handoff is a
  // no-op that reports handed_off=false. server.stop is refused because the host
  // app owns the daemon lifecycle. The rest are lightweight registries.
  private handleServerLiveHandoff(params: {
    expected_protocol?: number | null
    expected_version?: string | null
    import_exe?: string | null
  }) {
    if (params.expected_protocol !== null && params.expected_protocol !== undefined) {
      if (params.expected_protocol !== HERDR_PROTOCOL_VERSION) {
        return { handed_off: false, reason: 'protocol_mismatch' }
      }
    }
    return { handed_off: false, reason: 'already_live' }
  }

  private handleServerStop() {
    return { stopped: false, reason: 'managed_by_host' }
  }

  private handleServerReloadConfig() {
    return { reloaded: true }
  }

  private handleNotificationShow(params: {
    title: string
    body?: string
    position?: string
    sound?: string
  }) {
    return {
      shown: true,
      reason: 'shown' as const,
      title: params.title,
      position: params.position ?? 'bottom-right'
    }
  }

  private handlePopupClose(params: { id?: string | null }) {
    return { closed: true, id: params.id ?? null }
  }

  private handleClientWindowTitleSet(params: { title: string }) {
    this.windowTitle = params.title
    return { set: true, title: params.title }
  }

  private handleClientWindowTitleClear() {
    const previous = this.windowTitle
    this.windowTitle = null
    return { cleared: true, previous }
  }

  private handlePluginLink(params: { name: string; path?: string }) {
    this.plugins.set(params.name, { name: params.name, path: params.path, enabled: true })
    this.pluginLogs.push({ name: params.name, message: 'linked', ts: Date.now() })
    return { linked: true, name: params.name }
  }

  private handlePluginList() {
    return { plugins: [...this.plugins.values()] }
  }

  private handlePluginUnlink(params: { name: string }) {
    const existed = this.plugins.delete(params.name)
    this.pluginLogs.push({ name: params.name, message: 'unlinked', ts: Date.now() })
    return { unlinked: existed, name: params.name }
  }

  private handlePluginEnable(params: { name: string }) {
    const plugin = this.plugins.get(params.name)
    if (!plugin) {
      throw new HerdrRuntimeError('plugin_not_found', `Plugin ${params.name} not found`)
    }
    plugin.enabled = true
    return { enabled: true, name: params.name }
  }

  private handlePluginDisable(params: { name: string }) {
    const plugin = this.plugins.get(params.name)
    if (!plugin) {
      throw new HerdrRuntimeError('plugin_not_found', `Plugin ${params.name} not found`)
    }
    plugin.enabled = false
    return { disabled: true, name: params.name }
  }

  private handlePluginActionList(params: { name: string }) {
    if (!this.plugins.has(params.name)) {
      throw new HerdrRuntimeError('plugin_not_found', `Plugin ${params.name} not found`)
    }
    return { name: params.name, actions: [] as string[] }
  }

  private handlePluginActionInvoke(params: { name: string; action: string; args?: unknown[] }) {
    if (!this.plugins.has(params.name)) {
      throw new HerdrRuntimeError('plugin_not_found', `Plugin ${params.name} not found`)
    }
    this.pluginLogs.push({
      name: params.name,
      message: `invoked ${params.action}`,
      ts: Date.now()
    })
    return { invoked: true, name: params.name, action: params.action }
  }

  private handlePluginLogList(params: { name?: string | null }) {
    const logs = params.name
      ? this.pluginLogs.filter((entry) => entry.name === params.name)
      : [...this.pluginLogs]
    return { logs }
  }

  private handlePluginPaneOpen(params: { workspace_id?: string; tab_id?: string; label?: string }) {
    const workspace = this.model.listWorkspaces()[0]
    if (!workspace) {
      throw new HerdrRuntimeError('workspace_not_found', 'No workspace for plugin pane')
    }
    const tab = this.model.ensureTab(workspace.workspace_id, params.label ?? 'plugin')
    return { workspace_id: workspace.workspace_id, tab_id: tab.tab_id }
  }

  private handlePluginPaneFocus(params: { pane_id: string }) {
    this.model.focusPane(params.pane_id)
    this.emitEvent('pane.focused', { pane_id: params.pane_id })
    return { pane_id: params.pane_id }
  }

  private async handlePluginPaneClose(params: { pane_id: string }) {
    await this.handlePaneClose(params)
    return { pane_id: params.pane_id, closed: true }
  }

  private handleIntegrationInstall(params: { name: string }) {
    this.integrations.add(params.name)
    return { installed: true, name: params.name }
  }

  private handleIntegrationUninstall(params: { name: string }) {
    const existed = this.integrations.delete(params.name)
    return { uninstalled: existed, name: params.name }
  }

  private handlePaneGraphicsSet(params: { pane_id: string; protocol?: string }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    return { pane_id: params.pane_id, set: true, protocol: params.protocol ?? null }
  }

  private handlePaneGraphicsClear(params: { pane_id: string }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    return { pane_id: params.pane_id, cleared: true }
  }

  private handlePaneGraphicsInfo(params: { pane_id: string }) {
    const pane = this.model.getPane(params.pane_id)
    if (!pane) {
      throw new HerdrRuntimeError('pane_not_found', `Pane ${params.pane_id} not found`)
    }
    return { pane_id: params.pane_id, supported: false, protocol: null }
  }

  private async handleSshConnect(params: {
    host: string
    port?: number
    username?: string
    identityFile?: string
    configHost?: string
  }) {
    const result = await this.sshStore.connect(params)
    return {
      success: true,
      connection_id: result.connectionId,
      target_id: result.targetId
    }
  }

  private async handleSshDisconnect(params: { connection_id?: string }) {
    if (params.connection_id) {
      await this.sshStore.disconnect(params.connection_id)
      return { disconnected: true, connection_id: params.connection_id }
    }
    await this.sshStore.disconnectAll()
    return { disconnected: true }
  }

  private async handleRemoteAttach(params: {
    connection_id: string
    cols?: number
    rows?: number
    cwd?: string
    command?: string
  }): Promise<{ success: boolean; pane_id: string }> {
    const entry = this.sshStore.get(params.connection_id)
    if (!entry) {
      throw new HerdrRuntimeError(
        'ssh_not_found',
        `SSH connection ${params.connection_id} not found`
      )
    }
    const client = entry.connection.getClient()
    if (!client) {
      throw new HerdrRuntimeError('ssh_not_connected', 'SSH connection is not active')
    }
    const cols = params.cols ?? 120
    const rows = params.rows ?? 30
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ rows, cols, term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          reject(err)
          return
        }
        resolve(stream as ClientChannel)
      })
    })
    if (params.command) {
      channel.write(`${params.command}\r`)
    }
    const workspace = this.model.ensureWorkspace(`ssh:${entry.targetId}`)
    const tab = this.model.ensureTab(workspace.workspace_id, 'default')
    const pane = this.model.createPane(workspace.workspace_id, tab.tab_id, {
      cwd: params.cwd ?? '~',
      label: params.command ?? 'remote'
    })
    const modelPane = this.model.getPane(pane.pane_id)
    if (modelPane) {
      modelPane.connection_id = params.connection_id
    }
    const state: RemotePaneState = {
      channel,
      connectionId: params.connection_id,
      buffer: '',
      sequence: 0,
      cols,
      rows
    }
    this.remotePanes.set(pane.pane_id, state)
    this.emitEvent('pane.created', { pane_id: pane.pane_id })
    channel.on('data', (data: Buffer) => {
      const text = data.toString('utf8')
      state.buffer += text
      state.sequence += 1
      this.model.bumpPaneRevision(pane.pane_id)
      this.emitPaneData(pane.pane_id, text, state.sequence)
      this.detectRemotePaneAgent(pane.pane_id, state)
    })
    channel.on('close', () => {
      this.emitPaneExit(pane.pane_id, 0)
    })
    return { success: true, pane_id: pane.pane_id }
  }

  private detectRemotePaneAgent(paneId: string, state: RemotePaneState): void {
    const pane = this.model.getPane(paneId)
    if (!pane || pane.agent) {
      return
    }
    if (state.sequence % 10 !== 0) {
      return
    }
    const agent = detectAgentFromBuffer(state.buffer)
    if (agent) {
      this.model.setPaneAgent(paneId, agent)
      this.model.setPaneAgentStatus(paneId, 'working')
      this.emitEvent('pane.agent_detected', {
        pane_id: paneId,
        agent,
        agent_status: 'working'
      })
      this.emitAgentStatus(paneId, agent, 'working')
    }
  }

  private handleSshStateChange(targetId: string, state: { status: string }): void {
    if (state.status !== 'disconnected' && state.status !== 'error') {
      return
    }
    const connectionId = targetId
    const stalePaneIds: string[] = []
    for (const [paneId, remote] of this.remotePanes.entries()) {
      if (remote.connectionId === connectionId) {
        stalePaneIds.push(paneId)
      }
    }
    for (const paneId of stalePaneIds) {
      const remote = this.remotePanes.get(paneId)
      if (remote) {
        try {
          remote.channel.close()
        } catch {
          // Why: the channel may already be closed.
        }
      }
      this.remotePanes.delete(paneId)
      this.model.closePane(paneId)
      this.emitEvent('pane.closed', { pane_id: paneId })
    }
  }

  private handleEventsSubscribe(
    params: { subscriptions?: { type: string }[] | { type: string } },
    reply: HerdrServerReply
  ): { type: string } {
    const raw = params.subscriptions ?? []
    const kinds = (Array.isArray(raw) ? raw : [raw]).map((sub) => sub.type)

    const unknownKinds = kinds.filter((kind) => !HERDR_EVENT_KINDS.has(kind))
    if (unknownKinds.length > 0) {
      throw new HerdrRuntimeError(
        'unknown_event_type',
        `Unknown event type: ${unknownKinds.join(', ')}`
      )
    }

    // Why: subscribe keeps the connection open for pushes; notifyEvent routes by kind.
    reply.subscribe(kinds)
    return { type: 'subscription_started' }
  }

  private handleEventsWait(params: {
    match?: { type: string; pane_id?: string; workspace_id?: string; tab_id?: string }
    timeout_ms?: number
  }): Promise<HerdrSocketEventData | null> {
    const match: {
      type?: string
      pane_id?: string
      workspace_id?: string
      tab_id?: string
    } = params.match ?? {}
    const timeoutMs = Math.max(0, params.timeout_ms ?? 10_000)

    return new Promise((resolve) => {
      const listener = (event: HerdrSocketEventData): void => {
        if (match.type && event.type !== match.type) {
          return
        }
        if (match.pane_id && event.pane_id !== match.pane_id) {
          return
        }
        if (match.workspace_id && event.workspace_id !== match.workspace_id) {
          return
        }
        if (match.tab_id && event.tab_id !== match.tab_id) {
          return
        }
        clearTimeout(timer)
        this.eventBus.removeListener('event', listener)
        resolve(event)
      }
      const timer = setTimeout(() => {
        this.eventBus.removeListener('event', listener)
        resolve(null)
      }, timeoutMs)
      this.eventBus.on('event', listener)
    })
  }

  // Why: without this, every daemon teardown (test cleanup, supervisor
  // SIGTERM, process exit) orphans each pane's PTY child. On macOS/Linux the
  // node-pty spawn-helper and its shell become pid-1 orphans holding PTY
  // pairs; after enough runs the host's pty/pid budget is exhausted and
  // subsequent posix_openpt calls fail with ENXIO.
  async dispose(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    for (const [, state] of this.protocolPanes) {
      try {
        state.pty.kill()
      } catch {
        // Why: pane may have already exited.
      }
    }
    this.protocolPanes.clear()
    for (const [, state] of this.remotePanes) {
      try {
        state.channel.close()
      } catch {
        // Why: channel may have already closed.
      }
    }
    this.remotePanes.clear()
    this.eventBus.removeAllListeners()
    await this.sshStore.disconnectAll()
  }

  private emitPaneData(paneId: string, data: string, sequenceChars: number): void {
    const notification: HerdrNotification = {
      method: 'pane.data',
      params: { pane_id: paneId, data, sequence_chars: sequenceChars }
    }
    this.transport.notify(notification.method, notification.params)
    this.scheduleSave()
  }

  private emitPaneExit(paneId: string, code: number): void {
    const notification: HerdrNotification = {
      method: 'pane.exit',
      params: { pane_id: paneId, code }
    }
    this.transport.notify(notification.method, notification.params)
    this.emitEvent('pane.exited', { pane_id: paneId, code })
  }

  // Broadcast a protocol-19 event: to the local event bus (events.wait) and over
  // the wire to the connections whose events.subscribe registered the kind.
  private emitEvent(type: string, data: Record<string, unknown> = {}): void {
    const event: HerdrSocketEventData = { type, ...data }
    this.eventBus.emit('event', event)
    this.transport.notifyEvent(type, data)
    this.scheduleSave()
  }
}

// Why: the line of the pane buffer that first satisfies a wait_for_output match,
// so the client sees the concrete output that unblocked the wait.
function matchedLineFor(
  buffer: string,
  match: { type: 'substring' | 'regex'; value: string } | undefined
): string | null {
  if (!match) {
    return null
  }
  const normalized = buffer.replace(/\r\n?/g, '\n')
  const regex = match.type === 'regex' ? new RegExp(match.value) : null
  for (const line of normalized.split('\n')) {
    const probe = stripAnsiEscape(line)
    if (regex ? regex.test(probe) : probe.includes(match.value)) {
      return probe
    }
  }
  return null
}
