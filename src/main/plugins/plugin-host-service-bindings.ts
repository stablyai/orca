import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import type { PluginFocusedSurface } from '../../shared/plugins/plugin-focused-surface'
import {
  PLUGIN_WORKSPACE_TERMINAL_LIMIT,
  type PluginWorkspaceAgentContext,
  type PluginWorkspaceExecutionHost
} from '../../shared/plugins/plugin-host-api'
import type { HostContextLabelSources } from '../../shared/worktree/host-context-labels'
import {
  projectPluginAgentContext,
  projectPluginExecutionHost,
  selectPluginAgentLabels,
  type PluginAgentStatusSnapshot
} from '../../shared/plugins/plugin-workspace-read-context'
import type { PluginHostServices } from './plugin-host-methods'
import { PluginSidecarMailbox } from './plugin-sidecar-mailbox'
import { PluginSecretsStore } from './plugin-secrets-store'
import { PluginKvStore } from './plugin-storage-store'
import {
  describeAgentSessionPtyWriteRefusal,
  isAgentSessionPtyWriteRefusedError
} from '../../shared/agent-session-pty-write-admission'

/** Optional live sources for additive readContext labels. Absent in fakes. */
export type PluginWorkspaceReadContextSources = {
  hostLabelSources?: () => HostContextLabelSources
  listAgentStatuses?: () => readonly PluginAgentStatusSnapshot[]
  getProfileLabel?: () => string | null
}

/** Structural subset of OrcaRuntimeService exposed to plugin facade bindings. */
export type PluginRuntimeDelegate = {
  resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
    hostId?: string | null
    createdWithAgent?: string | null
    executionHost?: PluginWorkspaceExecutionHost | null
    agent?: PluginWorkspaceAgentContext | null
  } | null>
  listTerminals(
    worktreeSelector?: string,
    limit?: number,
    opts?: { includeVisualLayouts?: boolean }
  ): Promise<{ terminals: { handle: string; title: string | null }[] }>
  sendTerminal(
    handle: string,
    action: { text?: string; enter?: boolean }
  ): Promise<{ accepted: boolean }>
  dispatchPluginNotification(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }>
}

export function bindPluginHostServices(input: {
  delegate: PluginRuntimeDelegate
  pluginsDataDir: string
  subscribeEvents: (pluginKey: string, events: PluginEventName[]) => PluginEventName[]
  readContextSources?: PluginWorkspaceReadContextSources
  readFocusedSurface?: () => PluginFocusedSurface | null
  sidecarMailbox?: PluginSidecarMailbox
}): PluginHostServices {
  const { delegate, pluginsDataDir, subscribeEvents, readContextSources } = input
  const sidecarMailbox = input.sidecarMailbox ?? new PluginSidecarMailbox()
  return {
    resolveActiveWorktreeContext: async () => {
      const context = await delegate.resolveActiveWorktreeContext()
      if (!context) {
        return null
      }
      const selected = selectPluginAgentLabels(
        readContextSources?.listAgentStatuses?.() ?? [],
        context.worktreeId,
        context.createdWithAgent
      )
      // Why: retain the internal id only for host-side terminal membership;
      // the public handler projects it out because it embeds provider paths.
      return {
        worktreeId: context.worktreeId,
        branch: context.branch,
        displayName: context.displayName,
        executionHost:
          context.executionHost ??
          projectPluginExecutionHost(
            context.hostId,
            readContextSources?.hostLabelSources?.() ?? {}
          ),
        agent:
          context.agent ??
          projectPluginAgentContext({
            type: selected.type,
            model: selected.model,
            profile: readContextSources?.getProfileLabel?.() ?? null
          })
      }
    },
    listWorktreeTerminals: async (worktreeId) => {
      const result = await delegate.listTerminals(
        `id:${worktreeId}`,
        PLUGIN_WORKSPACE_TERMINAL_LIMIT,
        { includeVisualLayouts: false }
      )
      return result.terminals
        .slice(0, PLUGIN_WORKSPACE_TERMINAL_LIMIT)
        .map((terminal) => ({ id: terminal.handle }))
    },
    sendTerminalText: async (terminalId, action) => {
      try {
        const result = await delegate.sendTerminal(terminalId, action)
        return { accepted: result.accepted }
      } catch (error) {
        // Why: the plugin API carries only `accepted`, so a lease refusal would read as a silent
        // drop; restate it as the message idiom plugin methods already surface to callers.
        if (isAgentSessionPtyWriteRefusedError(error)) {
          throw new Error(describeAgentSessionPtyWriteRefusal(error.refusal))
        }
        throw error
      }
    },
    dispatchPluginNotification: (notification) => delegate.dispatchPluginNotification(notification),
    storage: {
      get: (key, itemKey) => new PluginKvStore(pluginsDataDir, key, 'storage.json').get(itemKey),
      set: (key, itemKey, value) =>
        new PluginKvStore(pluginsDataDir, key, 'storage.json').set(itemKey, value),
      delete: (key, itemKey) =>
        new PluginKvStore(pluginsDataDir, key, 'storage.json').delete(itemKey),
      keys: (key) => new PluginKvStore(pluginsDataDir, key, 'storage.json').keys()
    },
    secrets: {
      get: (key, itemKey) => new PluginSecretsStore(pluginsDataDir, key).get(itemKey),
      set: (key, itemKey, value) => new PluginSecretsStore(pluginsDataDir, key).set(itemKey, value),
      delete: (key, itemKey) => new PluginSecretsStore(pluginsDataDir, key).delete(itemKey)
    },
    settings: {
      getAll: (key) => new PluginKvStore(pluginsDataDir, key, 'settings.json').getAll(),
      set: (key, itemKey, value) =>
        new PluginKvStore(pluginsDataDir, key, 'settings.json').set(itemKey, value)
    },
    subscribeEvents,
    readFocusedSurface: input.readFocusedSurface ?? (() => null),
    sidecar: {
      resolvePlacement: (pluginId) => sidecarMailbox.resolvePlacement(pluginId),
      publish: (pluginId, frame) => sidecarMailbox.publish(pluginId, frame)
    }
  }
}
