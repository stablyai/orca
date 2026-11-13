import { ipcMain, type BrowserWindow } from 'electron'
import type { SleepingAgentWakeRequest } from '../../../shared/workspace-sleep'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { addFanoutListener } from '../../runtime/events/event-listener-fanout'
import { requestRendererReply } from './renderer-reply-request'

export function requestSleepingPaneWake(
  window: BrowserWindow,
  payload: SleepingAgentWakeRequest
): Promise<boolean> {
  return requestRendererReply<{ requestId: string; woke: boolean }>(window, {
    requestChannel: 'ui:resumeSleepingAgents',
    replyChannel: 'ui:resumeSleepingAgentsReply',
    payload,
    timeoutMs: 30_000,
    timeoutError: 'The agent could not be resumed; open its workspace to try again'
  }).then((reply) => reply.woke)
}

export function registerSleepingMailAvailability(
  window: BrowserWindow,
  runtime: Pick<OrcaRuntimeService, 'retrySleptMailboxWakes'>
): () => void {
  return addFanoutListener(
    ipcMain,
    'ui:sleepingMailAvailability',
    (event: Electron.IpcMainEvent, paneKey: unknown) => {
      if (
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        (paneKey === undefined || typeof paneKey === 'string')
      ) {
        runtime.retrySleptMailboxWakes(paneKey)
      }
    }
  )
}
