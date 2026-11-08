import { createHash } from 'node:crypto'
import {
  pluginDeclarativeStoredValueSchema,
  type PluginDeclarativeStoredValue
} from '../../../shared/plugins/declarative/plugin-declarative-messages'
import {
  pluginPanelStateRequestSchema,
  type PluginPanelStateResult
} from '../../../shared/plugins/declarative/plugin-declarative-panel-state'
import { PluginKvStore } from '../plugin-storage-store'

/**
 * Persisted atoms of components panels, in the plugin's own data folder (`panel-state.json`).
 * No capability: it is the panel's UI state, private to the plugin, like a web page's storage.
 */

/** Workspace ids are paths; a short digest keeps store keys small and path-free. */
function workspacePrefix(workspace: string): string {
  return `workspace/${createHash('sha256').update(workspace).digest('hex').slice(0, 16)}/`
}

function readScope(
  all: Record<string, unknown>,
  prefix: string
): Record<string, PluginDeclarativeStoredValue> {
  const scope: Record<string, PluginDeclarativeStoredValue> = {}
  for (const [storeKey, raw] of Object.entries(all)) {
    if (!storeKey.startsWith(prefix)) {
      continue
    }
    const parsed = pluginDeclarativeStoredValueSchema.safeParse(raw)
    if (parsed.success) {
      scope[storeKey.slice(prefix.length)] = parsed.data
    }
  }
  return scope
}

export function handlePluginPanelStateRequest(
  dependencies: {
    pluginsDataDir: string
    /** The plugin behind a live components-panel session of this owner, or null. */
    resolveComponentsPanel: (sessionToken: string) => string | null
  },
  raw: unknown
): PluginPanelStateResult {
  const parsed = pluginPanelStateRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: 'malformed panel state request' }
  }
  const request = parsed.data
  const pluginKey = dependencies.resolveComponentsPanel(request.sessionToken)
  if (!pluginKey) {
    return { ok: false, error: 'invalid panel session' }
  }
  const store = new PluginKvStore(dependencies.pluginsDataDir, pluginKey, 'panel-state.json')
  if (request.op === 'read') {
    const all = store.getAll()
    return {
      ok: true,
      state: {
        plugin: readScope(all, 'plugin/'),
        workspace: request.workspace ? readScope(all, workspacePrefix(request.workspace)) : {}
      }
    }
  }
  for (const entry of request.entries) {
    if (entry.scope === 'workspace' && !request.workspace) {
      continue
    }
    const prefix =
      entry.scope === 'plugin' || !request.workspace
        ? 'plugin/'
        : workspacePrefix(request.workspace)
    const written = store.set(`${prefix}${entry.key}`, {
      version: entry.version,
      value: entry.value
    })
    if (!written.ok) {
      return written
    }
  }
  return { ok: true }
}
