import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/types'
import type { PluginDevWatchEvent } from './plugin-dev-watch-events'

/** One `--shot` PNG written after a load or reload. */
export type PluginDevWatchShot = {
  panelId: string
  path: string
  width: number
  height: number
  /** False when the panel had not finished drawing by the host's timeout. */
  settled: boolean
  errors: string[]
  /** Host calls still unanswered at the capture; absent on hosts that predate it. */
  pendingRequests?: number
}

/** What `--shot` asks of the Orca host; the handler binds it to RPC. */
export type PluginDevWatchShotHost = {
  /** `--shot-panel`, else the plugin's first panel; null when it has none. Throws on an unknown id. */
  panelOf(entry: PluginHostListEntry | null): string | null
  /** Shows the panel in the right sidebar; called once per session. */
  open(pluginKey: string, panelId: string): Promise<void>
  /** Captures it only while it is the open right-sidebar tab. */
  take(pluginKey: string, panelId: string): Promise<PluginDevWatchShot | { notShown: string }>
}

/** Statuses whose panels Orca draws; an errored or invalid reload has nothing new to show. */
export const PLUGIN_DEV_WATCH_SHOOTABLE = new Set(['running', 'idle', 'restarting'])

/** A host that cannot capture now never will this session: too old, or no desktop window. */
export function isLastingShotFailure(error: unknown): boolean {
  if (error instanceof RuntimeRpcFailureError) {
    return error.response.error.message.includes('only available in the Orca desktop app')
  }
  return error instanceof RuntimeClientError && error.code === 'runtime_unsupported'
}

/** `--shot-panel` must name one of the plugin's panels; checked once, at start. */
export function pluginDevWatchShotPanel(
  entry: PluginHostListEntry | null,
  requested: string | undefined
): string | null {
  const ids = entry?.panels.map((panel) => panel.id) ?? []
  if (requested === undefined) {
    return ids[0] ?? null
  }
  if (entry && !ids.includes(requested)) {
    throw new RuntimeClientError(
      'invalid_argument',
      ids.length === 0
        ? `--shot-panel: ${entry.pluginKey} has no panels.`
        : `--shot-panel: ${entry.pluginKey} has no panel ${requested}; its panels: ${ids.join(', ')}.`
    )
  }
  return requested
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Opens the panel once, then captures it after each good reload while it stays on screen. Once
 * the person switches away it never switches back: it skips, saying so once per time away.
 */
export function createPluginDevWatchShooter(
  host: PluginDevWatchShotHost,
  pluginKey: string,
  panelId: string,
  emit: (event: PluginDevWatchEvent) => void
): () => Promise<void> {
  let opened = false
  let away = false
  let off = false
  const warn = (what: string, error: unknown): void => {
    off = isLastingShotFailure(error)
    emit({
      type: 'warning',
      message: `${what}${off ? ', so --shot is off' : ''}: ${errorMessage(error)}`
    })
  }
  return async () => {
    if (off) {
      return
    }
    if (!opened) {
      opened = true
      try {
        await host.open(pluginKey, panelId)
      } catch (error) {
        warn(`could not show ${panelId} for --shot`, error)
        if (off) {
          return
        }
      }
    }
    try {
      const outcome = await host.take(pluginKey, panelId)
      if ('notShown' in outcome) {
        if (!away) {
          away = true
          emit({ type: 'shot_skipped', pluginKey, panelId, reason: outcome.notShown })
        }
        return
      }
      away = false
      emit({ type: 'shot', pluginKey, ...outcome })
    } catch (error) {
      warn('shot could not run', error)
    }
  }
}
