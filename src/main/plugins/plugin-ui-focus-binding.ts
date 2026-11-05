import { app, BrowserWindow } from 'electron'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import {
  readPluginFocusedSurface,
  type PluginFocusedSurface
} from '../../shared/plugins/events/plugin-focused-surface'
import type { PluginEventName } from '../../shared/plugins/manifest/plugin-manifest'
import { watchPluginUiFocus } from './plugin-runtime-binding'

/** Emits `ui.focus.changed` from session writes and window focus; returns the reader `ui.readFocus` answers from. */
export function bindPluginUiFocus(
  store: {
    getWorkspaceSession(): WorkspaceSessionState
    onWorkspaceSessionWritten(listener: () => void): () => void
  },
  isServeMode: boolean,
  events: {
    emitEvent(event: PluginEventName, payload: unknown): void
    wantsEvent(event: PluginEventName): boolean
  }
): () => PluginFocusedSurface {
  // Headless serve has no window to lose focus; its session follows the paired client's navigation.
  const readFocusedSurface = () =>
    readPluginFocusedSurface(
      store.getWorkspaceSession(),
      isServeMode || BrowserWindow.getFocusedWindow() !== null
    )
  watchPluginUiFocus({
    events,
    readFocusedSurface,
    onFocusInputChanged: (listener) => {
      const stopSession = store.onWorkspaceSessionWritten(listener)
      app.on('browser-window-focus', listener)
      app.on('browser-window-blur', listener)
      return () => {
        stopSession()
        app.off('browser-window-focus', listener)
        app.off('browser-window-blur', listener)
      }
    }
  })
  return readFocusedSurface
}
