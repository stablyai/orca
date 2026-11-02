import type { PluginHostStatus } from '../../shared/plugins/plugin-list-entry'
import { formatPluginPanelCheck } from '../plugin-authoring/plugin-panel-check'
import type { PluginDevWatchCheckResult } from './plugin-dev-watch-check'
import { PLUGIN_DEV_WATCH_SHOOTABLE, type PluginDevWatchShot } from './plugin-dev-watch-shot'

/** `missing`: the host lists no plugin for the folder (for example, its id changed). */
export type PluginDevWatchStatus = PluginHostStatus | 'missing'

export type PluginDevWatchApproval = { message: string; fingerprint: string; command: string }

/** One `--json` line each; `type` is the discriminant agents switch on. */
export type PluginDevWatchEvent =
  | {
      type: 'loaded'
      pluginKey: string
      path: string
      added: boolean
      status: PluginDevWatchStatus
      error?: string
      typeFiles: string[]
    }
  | {
      type: 'log'
      pluginKey: string
      ts: number
      level: string
      line: string
      /** A panel line that arrived this many times together (absent: once). */
      count?: number
      /** `count` more copies of a panel line printed earlier in this reload. */
      repeat?: true
    }
  | {
      type: 'reloaded'
      pluginKey: string
      /** File changes the host saw since the last reload. */
      changes: number
      status: PluginDevWatchStatus
      error?: string
    }
  | {
      type: 'status'
      pluginKey: string
      status: PluginDevWatchStatus
      previousStatus: PluginDevWatchStatus
      error?: string
    }
  | ({ type: 'approval'; pluginKey: string } & PluginDevWatchApproval)
  /** `--check`: `orca plugin check` after the load and after each reload. `ok` also needs Orca to
   *  run the plugin (`pluginStatus` running, idle or restarting); `checkOk` is the check alone. */
  | ({
      type: 'check'
      pluginKey: string
      checkOk: boolean
      pluginStatus: PluginDevWatchStatus
      pluginError?: string
    } & PluginDevWatchCheckResult)
  /** `--shot`: a PNG of one panel after the load and after each reload that left it running. */
  | ({ type: 'shot'; pluginKey: string } & PluginDevWatchShot)
  /** `--shot`: the person switched away from the panel; once per time away, never switched back. */
  | { type: 'shot_skipped'; pluginKey: string; panelId: string; reason: string }
  | { type: 'warning'; message: string }
  | { type: 'disconnected'; message: string }
  | { type: 'unloaded'; pluginKey: string; path: string; removed: boolean }

function withError(status: PluginDevWatchStatus, error: string | undefined): string {
  return error ? `${status}: ${error}` : status
}

function clockTime(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function pluginStatusPhrase(status: PluginDevWatchStatus, error: string | undefined): string {
  const phrase =
    status === 'pending' ? 'pending approval' : status === 'missing' ? 'not loaded' : status
  return error ? `${phrase}: ${error}` : phrase
}

function checkHeadline(event: Extract<PluginDevWatchEvent, { type: 'check' }>): string {
  if (event.ok) {
    return `✓ check passed for ${event.pluginKey}`
  }
  if (!event.checkOk) {
    return `✗ check failed for ${event.pluginKey}`
  }
  return `✗ check passed, but in Orca ${event.pluginKey} is ${pluginStatusPhrase(event.pluginStatus, event.pluginError)}`
}

export function formatPluginDevWatchEvent(event: PluginDevWatchEvent): string {
  switch (event.type) {
    case 'loaded':
      return [
        `${event.added ? 'Loaded' : 'Watching'} ${event.pluginKey} from ${event.path} (${withError(event.status, event.error)}).`,
        ...event.typeFiles.map((file) => `Refreshed ${file}`),
        'Watching for changes and logs; Ctrl-C to stop.'
      ].join('\n')
    case 'log': {
      const times = event.repeat
        ? ` (×${event.count ?? 1} more)`
        : event.count && event.count > 1
          ? ` ×${event.count}`
          : ''
      return `${clockTime(event.ts)} ${event.level.padEnd(5)} ${event.line}${times}`
    }
    case 'reloaded': {
      const changes = event.changes === 1 ? '1 file changed' : `${event.changes} files changed`
      return `↻ reloaded ${event.pluginKey} (${changes}): ${withError(event.status, event.error)}`
    }
    case 'status':
      return `${event.pluginKey} is now ${withError(event.status, event.error)} (was ${event.previousStatus})`
    case 'approval':
      return `${event.pluginKey} needs approval: ${event.message}\n  To approve, run: ${event.command}`
    case 'check':
      return [
        checkHeadline(event),
        ...(!event.ok && !event.checkOk && !PLUGIN_DEV_WATCH_SHOOTABLE.has(event.pluginStatus)
          ? [`  in Orca: ${pluginStatusPhrase(event.pluginStatus, event.pluginError)}`]
          : []),
        ...event.invalid.map((error) => `  invalid: ${error}`),
        ...event.panels.flatMap(formatPluginPanelCheck).map((line) => `  ${line}`)
      ].join('\n')
    case 'shot':
      return [
        `shot ${event.path} (${event.width}x${event.height})${event.settled ? '' : ', not finished drawing'}`,
        ...(event.pendingRequests
          ? [
              `  note: ${event.pendingRequests} host call(s) were still unanswered; the panel may show its loading state`
            ]
          : []),
        ...event.errors.map((error) => `  error: ${error}`)
      ].join('\n')
    case 'shot_skipped':
      return `shot skipped: ${event.reason}, so ${event.panelId} is not on screen; open it again to resume`
    case 'warning':
      return `warning: ${event.message}`
    case 'disconnected':
      return `Lost the connection to Orca: ${event.message}`
    case 'unloaded':
      return event.removed
        ? `Unloaded ${event.pluginKey} (${event.path}).`
        : `Left ${event.pluginKey} loaded: it was loaded before this session.`
  }
}
