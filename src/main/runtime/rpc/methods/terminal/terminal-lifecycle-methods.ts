import { terminalImageViewerSupported } from '../../../terminal-image-viewer-env'
import { TERMINAL_WORKSPACE_STOP_METHODS } from './terminal-workspace-stop-methods'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../shared/sidebar-inputs-switch'
import { defineMethod } from '../../core'
import {
  navigationTargetsHost,
  resolveRuntimeNavigationTarget
} from '../../../../../shared/runtime-navigation'
import { withTerminalCloseAttribution } from '../../terminal-close-attribution'
import {
  AgentTeamsPrepareLaunch,
  AgentTeamsTmuxCompat,
  TerminalCreateParams,
  TerminalFocus,
  TerminalHandle,
  TerminalReveal,
  TerminalSplit,
  TerminalWait
} from '../../../../../shared/rpc-contract/terminal-unary-params'
import { TerminalResizeForClient } from '../../../../../shared/rpc-contract/terminal-stream-params'

export const TERMINAL_LIFECYCLE_METHODS = [
  defineMethod({
    name: 'terminal.wait',
    permission: 'workspace',
    params: TerminalWait,
    handler: async (params, { runtime, signal }) => ({
      wait: await runtime.waitForTerminal(params.terminal, {
        condition: params.for,
        timeoutMs: params.timeoutMs,
        signal
      })
    })
  }),
  defineMethod({
    name: 'terminal.create',
    permission: 'workspace',
    params: TerminalCreateParams,
    handler: async (params, context) => {
      const { runtime, pairedDeviceId, clientId, clientKind } = context
      // A focused terminal create predates paired-client navigation. Keep the
      // authority boundary here so a remote caller cannot activate the host
      // renderer. This legacy RPC remains a background create for paired viewers;
      // caller-local selection belongs to the session-tab RPC flow.
      const pairedViewer = clientKind !== undefined
      const focus = pairedViewer ? false : params.focus === true
      const activate = pairedViewer ? false : params.activate === true
      const presentation =
        pairedViewer && params.presentation === 'focused' ? 'background' : params.presentation
      // Switch point: the window's own new tab, which main starts; refused as a pane-named split is.
      if (params.windowTab) {
        // Only this host's own window draws its tabs, by the identity its IPC proved: that channel
        // also labels itself a client, and a paired viewer's window starts its own host's.
        if (
          context.caller?.kind !== 'desktop' ||
          !params.worktree?.startsWith('id:') ||
          !params.tabId ||
          !params.leafId
        ) {
          throw new Error('host_not_owned')
        }
        return {
          terminal: await runtime.startWindowTabTerminal(
            params.worktree.slice('id:'.length),
            { tabId: params.tabId, leafId: params.leafId },
            {
              command: params.command,
              ...(params.cwd ? { cwd: params.cwd } : {}),
              ...(params.shell ? { shellOverride: params.shell } : {}),
              startupCommandDelivery: params.startupCommandDelivery,
              env: params.env,
              envToDelete: params.envToDelete,
              ...(params.launchConfig ? { launchConfig: params.launchConfig } : {}),
              ...(params.resumeProviderSession
                ? { resumeProviderSession: params.resumeProviderSession }
                : {}),
              ...(params.launchToken ? { launchToken: params.launchToken } : {}),
              ...(params.launchAgent ? { launchAgent: params.launchAgent } : {}),
              terminalImageViewerSupported: terminalImageViewerSupported(context)
            }
          )
        }
      }
      const terminal = await runtime.dedupeTerminalCreate(
        pairedDeviceId ?? clientId ?? 'local',
        params.worktree,
        params.clientMutationId,
        params.reconcileExisting === true,
        (canonicalWorktreeSelector, preAllocatedHandle) =>
          runtime.createTerminal(canonicalWorktreeSelector, {
            command: params.command,
            terminalImageViewerSupported: terminalImageViewerSupported(context),
            ...(params.shell ? { shellOverride: params.shell } : {}),
            startupCommandDelivery: params.startupCommandDelivery,
            env: params.env,
            envToDelete: params.envToDelete,
            ...(params.launchConfig ? { launchConfig: params.launchConfig } : {}),
            ...(params.resumeProviderSession
              ? { resumeProviderSession: params.resumeProviderSession }
              : {}),
            ...(params.launchToken ? { launchToken: params.launchToken } : {}),
            ...(params.launchAgent ? { launchAgent: params.launchAgent } : {}),
            ...(params.terminalKittyKeyboardProtocol === true
              ? { terminalKittyKeyboardProtocol: true }
              : {}),
            ...(params.terminalColorQueryReplies
              ? { terminalColorQueryReplies: params.terminalColorQueryReplies }
              : {}),
            title: params.title,
            focus,
            activate,
            presentation,
            tabId: params.tabId,
            leafId: params.leafId,
            ...(params.spawnIntent ? { spawnIntent: params.spawnIntent } : {}),
            ...(preAllocatedHandle ? { preAllocatedHandle } : {})
          })
      )
      // Switch point. A CLI start is work in the workspace; a window or phone tab is a person opening one.
      if (
        ORCA_SIDEBAR_INPUTS_IS_MAIN &&
        context.caller?.kind === 'local-cli' &&
        !terminal.isReattach
      ) {
        runtime.sidebarFacts?.sortStamps.noteTerminalStarted(
          terminal.worktreeId,
          terminal.executionHostId
        )
      }
      const publicTerminal = { ...terminal }
      delete publicTerminal.savedStartupCwd
      return { terminal: publicTerminal }
    }
  }),
  defineMethod({
    name: 'terminal.split',
    permission: 'workspace',
    params: TerminalSplit,
    handler: async (params, { runtime }) => ({
      split:
        params.pane && !params.terminal
          ? await runtime.splitTerminalPane(params.pane, {
              direction: params.direction ?? 'horizontal',
              newLeafId: params.newLeafId,
              cwd: params.cwd,
              initialSize: params.initialSize,
              command: params.command,
              env: params.env,
              // The window's split shows why its start failed, as its own spawn did.
              keepPaneOnStartFailure: true
            })
          : // The schema requires a handle when no pane is named.
            await runtime.splitTerminal(params.terminal ?? '', {
              direction: params.direction,
              command: params.command,
              env: params.env,
              telemetrySource: params.telemetrySource,
              retrySplit: params.retrySplit
            })
    })
  }),
  ...TERMINAL_WORKSPACE_STOP_METHODS,
  defineMethod({
    name: 'terminal.resizeForClient',
    permission: 'workspace',
    params: TerminalResizeForClient,
    handler: async (params, { runtime }) => {
      // Why: a stale handle must fail with terminal_handle_stale, not resize the wrong PTY (#7718).
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      const result = await runtime.resizeForClient(
        leaf.ptyId,
        params.mode,
        params.clientId,
        params.mode === 'mobile-fit' ? params.cols : undefined,
        params.mode === 'mobile-fit' ? params.rows : undefined
      )
      return {
        terminal: {
          handle: params.terminal,
          ...result
        }
      }
    }
  }),
  defineMethod({
    name: 'terminal.focus',
    permission: 'workspace',
    params: TerminalFocus,
    handler: async (params, { runtime, clientKind }) => ({
      focus: await runtime.focusTerminal(params.terminal, {
        navigateHost: navigationTargetsHost(
          resolveRuntimeNavigationTarget({ navigation: params.navigation, clientKind })
        )
      })
    })
  }),
  defineMethod({
    // Why a method of its own: terminal.focus resolves a handle on the host that runs the PTY, and a
    // paired server has no window, so only the desktop showing its pane can reveal it (#24688).
    name: 'terminal.reveal',
    permission: 'workspace',
    params: TerminalReveal,
    handler: async (params, { runtime, clientKind }) => {
      // Why local callers only: it moves this host's window, which terminal.focus lets a paired
      // client do only by asking for host navigation, and a CLI or companion app here needs no more.
      if (clientKind !== undefined) {
        throw Object.assign(
          new Error('terminal.reveal is available only to callers on this machine.'),
          { code: 'forbidden' }
        )
      }
      return {
        reveal: await runtime.revealTerminalPane({
          worktreeId: params.worktreeId,
          tabId: params.tabId,
          leafId: params.leafId ?? null,
          executionHostId: params.executionHostId ?? null
        })
      }
    }
  }),
  defineMethod({
    name: 'terminal.close',
    permission: 'workspace',
    params: TerminalHandle,
    handler: async (params, context) => ({
      close: await withTerminalCloseAttribution(
        'terminal.close',
        context,
        'terminal',
        params.terminal,
        () => context.runtime.closeTerminal(params.terminal)
      )
    })
  }),
  defineMethod({
    name: 'terminal.closeTab',
    permission: 'workspace',
    params: TerminalHandle,
    handler: async (params, context) => ({
      close: await withTerminalCloseAttribution(
        'terminal.closeTab',
        context,
        'terminal-tab',
        params.terminal,
        () => context.runtime.closeTerminalTab(params.terminal)
      )
    })
  }),
  defineMethod({
    name: 'agentTeams.tmuxCompat',
    permission: 'workspace',
    params: AgentTeamsTmuxCompat,
    handler: async (params, { runtime }) => ({
      tmux: await runtime.handleAgentTeamsTmuxCompat(params)
    })
  }),
  defineMethod({
    name: 'agentTeams.prepareLaunch',
    permission: 'workspace',
    params: AgentTeamsPrepareLaunch,
    handler: async (params, { runtime }) => ({
      launch: await runtime.prepareClaudeAgentTeamsLeader({
        paneKey: params.paneKey,
        baseEnv: params.env,
        prepareAuth: params.prepareAuth
      })
    })
  })
]
