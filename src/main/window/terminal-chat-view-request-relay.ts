import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { RuntimeSessionTabChatView } from '../../shared/runtime-session-contracts'
import {
  TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR,
  type TerminalChatViewRequest,
  type TerminalChatViewResponse
} from '../../shared/terminal-chat-view-request'
import type {
  AgentExitRetirementCondition,
  AgentExitRetirementDisposition
} from '../../shared/agent-exit-retirement'
import {
  NATIVE_CHAT_TARGET_READ_RELAY_TIMEOUT_MS,
  type NativeChatTargetRead,
  type NativeChatTargetReadRequest,
  type NativeChatTargetReadResponse
} from '../../shared/native-chat-target-read'

// Why 10 s: below every client's own timeout, so a slow renderer surfaces as delivery-unknown.
const TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_MS = 10_000

/**
 * One request to the renderer that owns a desktop host's tabs, answered on `responseChannel` by
 * the same webContents. Sent synchronously in this call so IPC order equals call order; the
 * listener and timer are released on every outcome.
 */
function requestFromRenderer<TResponse extends { requestId: string }>(
  mainWindow: BrowserWindow,
  channels: { request: string; response: string },
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<TResponse> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new Error('renderer_unavailable'))
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return new Promise<TResponse>((resolve, reject) => {
    let settled = false
    const finish = (result: { response: TResponse } | { error: Error }): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener(channels.response, onResponse)
      mainWindow.removeListener('closed', onRendererUnavailable)
      webContents.removeListener('destroyed', onRendererUnavailable)
      webContents.removeListener('render-process-gone', onRendererUnavailable)
      webContents.removeListener('did-start-loading', onRendererUnavailable)
      if ('error' in result) {
        reject(result.error)
      } else {
        resolve(result.response)
      }
    }
    const onRendererUnavailable = (): void => finish({ error: new Error('renderer_unavailable') })
    const onResponse = (event: Electron.IpcMainEvent, response: TResponse): void => {
      if (event.sender !== webContents || response?.requestId !== requestId) {
        return
      }
      finish({ response })
    }
    const timeout = setTimeout(
      () => finish({ error: new Error(TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR) }),
      timeoutMs
    )
    timeout.unref?.()
    ipcMain.on(channels.response, onResponse)
    mainWindow.once('closed', onRendererUnavailable)
    webContents.once('destroyed', onRendererUnavailable)
    webContents.once('render-process-gone', onRendererUnavailable)
    webContents.once('did-start-loading', onRendererUnavailable)
    try {
      webContents.send(channels.request, { requestId, ...payload })
    } catch {
      finish({ error: new Error('renderer_unavailable') })
    }
  })
}

const CHAT_VIEW_CHANNELS = {
  request: 'ui:terminalChatViewRequest',
  response: 'ui:terminalChatViewResponse'
}

/**
 * Asks the renderer, which owns a desktop host's tabs, to apply a chat pair and reply with the
 * pair it holds.
 */
export async function requestTerminalChatViewFromRenderer(
  mainWindow: BrowserWindow,
  args: Omit<TerminalChatViewRequest, 'requestId'>
): Promise<RuntimeSessionTabChatView> {
  const response = await requestFromRenderer<TerminalChatViewResponse>(
    mainWindow,
    CHAT_VIEW_CHANNELS,
    args,
    TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_MS
  )
  if (!response.chatView || response.error) {
    throw new Error(response.error ?? 'chat_view_reply_missing')
  }
  return response.chatView
}

/** An agent exit's conditional retirement on the renderer's store; resolves its disposition. */
export async function requestAgentExitRetirementFromRenderer(
  mainWindow: BrowserWindow,
  args: { worktreeId: string; tabId: string; condition: AgentExitRetirementCondition }
): Promise<AgentExitRetirementDisposition> {
  const { leafId, ...agentExit } = args.condition
  const response = await requestFromRenderer<TerminalChatViewResponse>(
    mainWindow,
    CHAT_VIEW_CHANNELS,
    { worktreeId: args.worktreeId, tabId: args.tabId, leafId, viewMode: 'terminal', agentExit },
    TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_MS
  )
  if (!response.agentExitDisposition) {
    throw new Error(response.error ?? 'agent_exit_reply_missing')
  }
  return response.agentExitDisposition
}

/** Read-only: whether the renderer's committed state lets a composer write reach `ptyId`. */
export async function requestNativeChatTargetFromRenderer(
  mainWindow: BrowserWindow,
  args: Omit<NativeChatTargetReadRequest, 'requestId'>
): Promise<NativeChatTargetRead> {
  const response = await requestFromRenderer<NativeChatTargetReadResponse>(
    mainWindow,
    { request: 'ui:nativeChatTargetRead', response: 'ui:nativeChatTargetReadResponse' },
    args,
    NATIVE_CHAT_TARGET_READ_RELAY_TIMEOUT_MS
  )
  if (!response.read) {
    throw new Error('native_chat_target_reply_missing')
  }
  return response.read
}
