import { ipcRenderer } from 'electron'
import {
  THEME_STUDIO_CURRENT_CHANNEL,
  THEME_STUDIO_PREVIEW_CHANNEL,
  THEME_STUDIO_REPLY_CHANNEL,
  THEME_STUDIO_REPORT_CHANNEL,
  THEME_STUDIO_REQUEST_CHANNEL,
  THEME_STUDIO_USER_ACTION_CHANNEL,
  type ThemeStudioReply,
  type ThemeStudioReport,
  type ThemeStudioRequest,
  type ThemeStudioUserAction
} from '../../../shared/theme-studio/theme-studio-protocol'

/** `orca theme` drafts: main paints them here, and this window reports and answers back. */
export type ThemeStudioApi = {
  /** Untrusted until the renderer parses it. */
  current: () => Promise<unknown>
  onPreview: (callback: (preview: unknown) => void) => () => void
  report: (report: ThemeStudioReport) => void
  onRequest: (callback: (request: ThemeStudioRequest) => void) => () => void
  reply: (reply: ThemeStudioReply) => void
  userAction: (action: ThemeStudioUserAction) => void
}

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const themeStudioApi: ThemeStudioApi = {
  current: () => ipcRenderer.invoke(THEME_STUDIO_CURRENT_CHANNEL),
  onPreview: (callback) => subscribe(THEME_STUDIO_PREVIEW_CHANNEL, callback),
  report: (report) => ipcRenderer.send(THEME_STUDIO_REPORT_CHANNEL, report),
  onRequest: (callback) => subscribe(THEME_STUDIO_REQUEST_CHANNEL, callback),
  reply: (reply) => ipcRenderer.send(THEME_STUDIO_REPLY_CHANNEL, reply),
  userAction: (action) => ipcRenderer.send(THEME_STUDIO_USER_ACTION_CHANNEL, action)
}
