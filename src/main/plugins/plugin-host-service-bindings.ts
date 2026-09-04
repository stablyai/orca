import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../shared/plugins/plugin-host-api'
import type { PluginWorkspaceRef } from '../../shared/plugins/plugin-host-file-api'
import type { PluginHostServices } from './plugin-host-methods'
import type { PluginCapability } from '../../shared/plugins/plugin-capabilities'
import type {
  PluginFileExecutionResult,
  PluginFileMethod
} from '../runtime/runtime-file-commands-search-remote-quick-open-file-paths'
import { PluginSecretsStore } from './plugin-secrets-store'
import { PluginKvStore } from './plugin-storage-store'
import {
  describeAgentSessionPtyWriteRefusal,
  isAgentSessionPtyWriteRefusedError
} from '../../shared/agent-session-pty-write-admission'

/** Structural subset of OrcaRuntimeService exposed to plugin facade bindings. */
export type PluginRuntimeDelegate = {
  listPluginWorkspaces(): Promise<unknown>
  resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
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
  executePluginFileMethod(
    method: PluginFileMethod,
    worktreeSelector: string,
    relativePath: string,
    grant: { paths: readonly string[] }
  ): Promise<PluginFileExecutionResult>
}

export type PluginWorkspaceAuthorityRef =
  | { scope: 'worktree-identity'; identity: string }
  | { scope: 'folder-workspace'; folderWorkspaceId: string }

export function translatePluginWorkspaceRef(ref: PluginWorkspaceRef): PluginWorkspaceAuthorityRef {
  return ref.type === 'worktree'
    ? { scope: 'worktree-identity', identity: ref.identity }
    : { scope: 'folder-workspace', folderWorkspaceId: ref.id }
}

function readPluginWorkspaceRef(params: unknown): PluginWorkspaceRef | null {
  if (typeof params !== 'object' || params === null || !('workspaceRef' in params)) {
    return null
  }
  const workspaceRef = (params as { workspaceRef?: unknown }).workspaceRef
  if (typeof workspaceRef !== 'object' || workspaceRef === null || !('type' in workspaceRef)) {
    return null
  }
  return workspaceRef as PluginWorkspaceRef
}

function readPluginFileParams(
  params: unknown
): { workspaceRef: PluginWorkspaceRef; relativePath: string } | null {
  const workspaceRef = readPluginWorkspaceRef(params)
  if (
    !workspaceRef ||
    typeof params !== 'object' ||
    params === null ||
    !('relativePath' in params)
  ) {
    return null
  }
  const relativePath = (params as { relativePath?: unknown }).relativePath
  return typeof relativePath === 'string' ? { workspaceRef, relativePath } : null
}

function pluginWorkspaceSelector(ref: PluginWorkspaceRef): string {
  const authority = translatePluginWorkspaceRef(ref)
  return authority.scope === 'worktree-identity'
    ? `identity:${authority.identity}`
    : `id:${authority.folderWorkspaceId}`
}

function readGrant(grant: PluginCapability): { paths: readonly string[] } | null {
  return grant.kind === 'files:read' ? grant : null
}

export function bindPluginHostServices(input: {
  delegate: PluginRuntimeDelegate
  pluginsDataDir: string
  subscribeEvents: (pluginKey: string, events: PluginEventName[]) => PluginEventName[]
}): PluginHostServices {
  const { delegate, pluginsDataDir, subscribeEvents } = input
  return {
    executeAuthorizedPluginHostCall: async (method, params, grant) => {
      const fileParams = readPluginFileParams(params)
      const scopedGrant = readGrant(grant)
      if (
        !['files.read', 'files.stat', 'files.readDir'].includes(method) ||
        !fileParams ||
        !scopedGrant
      ) {
        return { authorized: false }
      }
      return delegate.executePluginFileMethod(
        method as PluginFileMethod,
        pluginWorkspaceSelector(fileParams.workspaceRef),
        fileParams.relativePath,
        scopedGrant
      )
    },
    listPluginWorkspaces: () => delegate.listPluginWorkspaces(),
    resolveActiveWorktreeContext: async () => {
      const context = await delegate.resolveActiveWorktreeContext()
      if (!context) {
        return null
      }
      // Why: retain the internal id only for host-side terminal membership;
      // the public handler projects it out because it embeds provider paths.
      return {
        worktreeId: context.worktreeId,
        branch: context.branch,
        displayName: context.displayName
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
    subscribeEvents
  }
}
