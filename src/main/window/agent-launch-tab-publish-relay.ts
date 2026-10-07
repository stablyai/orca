import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishReply,
  AgentLaunchTabPublishRequest
} from '../../shared/agent-launch-tab-publication'

const AGENT_LAUNCH_TAB_PUBLISH_TIMEOUT_MS = 10_000

/** Asks the window to show a launch's tab under the host's ids; resolves with where it landed. */
export function requestAgentLaunchTabPublishFromRenderer(
  mainWindow: BrowserWindow,
  request: Omit<AgentLaunchTabPublishRequest, 'requestId'>
): Promise<AgentLaunchTabPublished> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new Error('renderer_unavailable'))
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return new Promise<AgentLaunchTabPublished>((resolve, reject) => {
    const finish = (error: Error | null, published?: AgentLaunchTabPublished): void => {
      clearTimeout(timeout)
      ipcMain.removeListener('agentLaunch:tabPublishReply', onReply)
      if (error) {
        reject(error)
      } else if (published) {
        resolve(published)
      }
    }
    const timeout = setTimeout(
      () => finish(new Error('agent_launch_tab_publish_timeout')),
      AGENT_LAUNCH_TAB_PUBLISH_TIMEOUT_MS
    )
    const onReply = (event: Electron.IpcMainEvent, reply: AgentLaunchTabPublishReply): void => {
      // Why: request ids are visible to renderer code; only the targeted window may answer.
      if (event.sender !== webContents || reply.requestId !== requestId) {
        return
      }
      if ('error' in reply) {
        finish(new Error(reply.error))
        return
      }
      finish(null, { tabId: reply.tabId, created: reply.created, placement: reply.placement })
    }
    ipcMain.on('agentLaunch:tabPublishReply', onReply)
    webContents.send('ui:publishAgentLaunchTab', { ...request, requestId })
  })
}
