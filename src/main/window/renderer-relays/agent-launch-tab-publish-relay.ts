import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  AgentLaunchSplitReply,
  AgentLaunchSplitRequest
} from '../../../shared/agent-launch/contracts/agent-launch-split'
import { requestRendererReply } from './renderer-reply-request'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishReply,
  AgentLaunchTabPublishRequest
} from '../../../shared/agent-launch/contracts/agent-launch-tab-publication'

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
      // Renderer-visible request IDs grant no authority; accept only the targeted window's reply.
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

export function agentLaunchTabRelays(mainWindow: BrowserWindow) {
  return {
    publishAgentLaunchTab: (request: Omit<AgentLaunchTabPublishRequest, 'requestId'>) =>
      requestAgentLaunchTabPublishFromRenderer(mainWindow, request),
    /** Rejects without an answer: the window may still have moved the chat, so it is unconfirmed. */
    placeAgentLaunchSplit: (request: Omit<AgentLaunchSplitRequest, 'requestId'>) =>
      requestRendererReply<AgentLaunchSplitReply>(mainWindow, {
        requestChannel: 'ui:placeAgentLaunchSplit',
        replyChannel: 'agentLaunch:splitReply',
        payload: request,
        // The window stops placing at expiresAt; this only covers its answer arriving.
        timeoutMs: Math.max(0, request.expiresAt - Date.now()) + 5_000,
        timeoutError: 'agent_launch_split_unconfirmed'
      }).then((reply) => reply.placement)
  }
}
