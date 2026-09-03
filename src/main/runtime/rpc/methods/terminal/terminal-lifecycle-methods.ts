import { defineMethod, type RpcAnyMethod } from '../../core'
import {
  navigationTargetsHost,
  resolveRuntimeNavigationTarget
} from '../../../../../shared/runtime-navigation'
import { withTerminalCloseAttribution } from '../../terminal-close-attribution'
import {
  AgentTeamsPrepareLaunch,
  AgentTeamsTmuxCompat,
  TerminalCloseAll,
  TerminalCreateParams,
  TerminalFocus,
  TerminalHandle,
  TerminalSleep,
  TerminalSplit,
  TerminalStop,
  TerminalStopExact,
  TerminalWait
} from './unary-schemas'
import { TerminalResizeForClient } from './stream-schemas'

export const TERMINAL_LIFECYCLE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.wait',
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
    params: TerminalCreateParams,
    handler: async (params, { runtime, pairedDeviceId, clientId, clientKind }) => {
      // A focused terminal create predates paired-client navigation. Keep the
      // authority boundary here so a remote caller cannot activate the host
      // renderer. This legacy RPC remains a background create for paired viewers;
      // caller-local selection belongs to the session-tab RPC flow.
      const pairedViewer = clientKind !== undefined
      const focus = pairedViewer ? false : params.focus === true
      const activate = pairedViewer ? false : params.activate === true
      const presentation =
        pairedViewer && params.presentation === 'focused' ? 'background' : params.presentation
      return {
        terminal: await runtime.dedupeTerminalCreate(
          pairedDeviceId ?? clientId ?? 'local',
          params.worktree,
          params.clientMutationId,
          params.reconcileExisting === true,
          (canonicalWorktreeSelector, preAllocatedHandle) =>
            runtime.createTerminal(canonicalWorktreeSelector, {
              command: params.command,
              startupCommandDelivery: params.startupCommandDelivery,
              env: params.env,
              envToDelete: params.envToDelete,
              ...(params.launchConfig ? { launchConfig: params.launchConfig } : {}),
              ...(params.resumeProviderSession
                ? { resumeProviderSession: params.resumeProviderSession }
                : {}),
              ...(params.launchToken ? { launchToken: params.launchToken } : {}),
              ...(params.launchAgent ? { launchAgent: params.launchAgent } : {}),
              ...(params.terminalColorQueryReplies
                ? { terminalColorQueryReplies: params.terminalColorQueryReplies }
                : {}),
              title: params.title,
              focus,
              rendererBacked: params.rendererBacked === true,
              activate,
              presentation,
              tabId: params.tabId,
              leafId: params.leafId,
              ...(preAllocatedHandle ? { preAllocatedHandle } : {})
            })
        )
      }
    }
  }),
  defineMethod({
    name: 'terminal.split',
    params: TerminalSplit,
    handler: async (params, { runtime }) => ({
      split: await runtime.splitTerminal(params.terminal, {
        direction: params.direction,
        command: params.command,
        env: params.env,
        telemetrySource: params.telemetrySource
      })
    })
  }),
  defineMethod({
    name: 'terminal.stop',
    params: TerminalStop,
    handler: async (params, { runtime }) => runtime.stopTerminalsForWorktree(params.worktree)
  }),
  defineMethod({
    name: 'terminal.closeAll',
    params: TerminalCloseAll,
    handler: async (params, { runtime }) => runtime.closeTerminalsForWorktree(params.worktree)
  }),
  defineMethod({
    name: 'terminal.sleep',
    params: TerminalSleep,
    handler: async (params, { runtime }) => runtime.sleepTerminalsForWorktree(params.worktree)
  }),
  defineMethod({
    name: 'terminal.stopExact',
    params: TerminalStopExact,
    handler: async (params, { runtime }) =>
      runtime.stopExactTerminalsForWorktree(params.worktree, params.expectedPtyIds, {
        keepHistory: params.keepHistory,
        targetOnly: params.targetOnly
      })
  }),
  defineMethod({
    name: 'terminal.resizeForClient',
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
    name: 'terminal.close',
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
    params: AgentTeamsTmuxCompat,
    handler: async (params, { runtime }) => ({
      tmux: await runtime.handleAgentTeamsTmuxCompat(params)
    })
  }),
  defineMethod({
    name: 'agentTeams.prepareLaunch',
    params: AgentTeamsPrepareLaunch,
    handler: async (params, { runtime }) => ({
      launch: await runtime.prepareClaudeAgentTeamsLeader({
        paneKey: params.paneKey,
        baseEnv: params.env
      })
    })
  })
]
