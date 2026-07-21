import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { DictationOutputControlService } from '../speech/dictation-output-control'
import { dictationOutputControlService } from '../speech/dictation-output-control'
import {
  clampDuckedVolumePercent,
  normalizeDictationOutputVolumeMode
} from '../../shared/dictation-output-settings'
import { isTrustedUIRenderer } from './ui'

function assertTrustedDictationOutputSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedUIRenderer(event.sender)) {
    throw new Error('Unauthorized dictation output IPC sender')
  }
}

const DictationOutputApplyRequest = z.object({
  sessionId: z.string().min(1),
  settings: z.object({
    pauseMedia: z.unknown(),
    volumeMode: z.unknown(),
    duckedVolumePercent: z.unknown()
  })
})

const DictationOutputRestoreRequest = z.object({
  sessionId: z.string().min(1)
})

function sessionOwnerKey(event: IpcMainInvokeEvent, sessionId: string): string {
  return `${event.sender.id}:${sessionId}`
}

const registeredCleanupSenders = new WeakSet<IpcMainInvokeEvent['sender']>()

function registerSenderCleanup(
  event: IpcMainInvokeEvent,
  service: DictationOutputControlService
): void {
  if (typeof event.sender.once !== 'function') {
    return
  }
  if (registeredCleanupSenders.has(event.sender)) {
    return
  }
  registeredCleanupSenders.add(event.sender)
  const ownerId = String(event.sender.id)
  let restored = false
  const restoreOwner = (): void => {
    if (restored) {
      return
    }
    restored = true
    registeredCleanupSenders.delete(event.sender)
    void service.restoreForOwner(ownerId)
  }
  event.sender.once('destroyed', restoreOwner)
  event.sender.once('render-process-gone', restoreOwner)
}

export function registerDictationOutputControlHandlers(
  service: DictationOutputControlService = dictationOutputControlService
): void {
  ipcMain.removeHandler('dictationOutput:getCapabilities')
  ipcMain.removeHandler('dictationOutput:apply')
  ipcMain.removeHandler('dictationOutput:restore')

  ipcMain.handle('dictationOutput:getCapabilities', (event) => {
    assertTrustedDictationOutputSender(event)
    return service.getCapabilities()
  })
  ipcMain.handle('dictationOutput:apply', async (event, rawRequest: unknown): Promise<void> => {
    assertTrustedDictationOutputSender(event)
    registerSenderCleanup(event, service)
    const request = DictationOutputApplyRequest.parse(rawRequest)
    await service.applyForSession(sessionOwnerKey(event, request.sessionId), {
      pauseMedia: request.settings.pauseMedia === true,
      volumeMode: normalizeDictationOutputVolumeMode(request.settings.volumeMode),
      duckedVolumePercent: clampDuckedVolumePercent(request.settings.duckedVolumePercent)
    })
  })
  ipcMain.handle('dictationOutput:restore', async (event, rawRequest: unknown): Promise<void> => {
    assertTrustedDictationOutputSender(event)
    const request = DictationOutputRestoreRequest.parse(rawRequest)
    await service.restoreForSession(sessionOwnerKey(event, request.sessionId))
  })
}
