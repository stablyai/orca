import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import type { PtyRendererDelivery } from '../session'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { setPtyHostBindings, type PtyIpcSurface } from '../../pty-host-bindings'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { installPtyModelCheckpointIpc } from './model-checkpoint'
import {
  createCheckpointRuntime,
  kittyImage
} from '../../../runtime/headless-model-checkpoint-test-fixture'
import { PTY_ID } from '../../../runtime/headless-hydration-ownership-test-fixture'

export const incarnationId = 'current-incarnation'
const handlers = new Map<string, Parameters<PtyIpcSurface['handle']>[1]>()
export const contents: EventEmitter & {
  id: number
  mainFrame: object
  isDestroyed: Mock<() => boolean>
  send: Mock<() => void>
} = Object.assign(new EventEmitter(), {
  id: 12,
  mainFrame: {},
  isDestroyed: vi.fn(() => false),
  send: vi.fn<() => void>()
})
export const mainWindow = {
  webContents: contents,
  isDestroyed: vi.fn(() => false),
  isFocused: () => false,
  isVisible: () => false,
  isMinimized: () => false
}

export function ipcEvent(
  sender: unknown = contents,
  senderFrame: unknown = contents.mainFrame
): IpcMainInvokeEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This handler uses only sender and senderFrame identity; the fixture supplies those fields.
  return { sender, senderFrame } as IpcMainInvokeEvent
}

export async function invoke(
  channel: string,
  request: unknown,
  event = ipcEvent()
): Promise<unknown> {
  const handler = handlers.get(`pty:${channel}`)
  if (!handler) {
    throw new Error('Expected registered checkpoint handler')
  }
  return handler(event, request)
}

export function install() {
  const runtime = createCheckpointRuntime()
  runtime.acceptPtyIncarnationForExit(PTY_ID, incarnationId)
  runtime.onPtyData(PTY_ID, `FIRST${kittyImage()}`, 1)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The EventEmitter supplies the lifecycle methods used here; Electron's fluent return type requires a WebContents instance.
  const delivery = mainWindow as unknown as PtyRendererDelivery
  installPtyModelCheckpointIpc({ runtime, mainWindow: delivery })
  return runtime
}

export async function capture() {
  const result = await invoke('captureModelCheckpoint', {
    id: PTY_ID,
    expectedIncarnationId: incarnationId
  })
  if (
    !result ||
    typeof result !== 'object' ||
    !('leaseId' in result) ||
    typeof result.leaseId !== 'string'
  ) {
    throw new Error('Expected complete checkpoint lease')
  }
  return { ...result, leaseId: result.leaseId }
}

export function read(leaseId: string, event = ipcEvent()) {
  return invoke(
    'readModelCheckpoint',
    { id: PTY_ID, leaseId, resourceId: null, offset: 0, length: 1 },
    event
  )
}

beforeEach(() => {
  handlers.clear()
  contents.removeAllListeners()
  contents.isDestroyed.mockReturnValue(false)
  mainWindow.isDestroyed.mockReturnValue(false)
  setPtyHostBindings({
    ipc: {
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      },
      removeHandler: (channel) => {
        handlers.delete(channel)
      },
      on: () => {},
      removeAllListeners: () => {}
    }
  })
  ptyOwnership.set(PTY_ID, null)
  ptyIncarnationById.set(PTY_ID, incarnationId)
})

afterEach(() => {
  installPtyModelCheckpointIpc({})
  ptyOwnership.delete(PTY_ID)
  ptyIncarnationById.delete(PTY_ID)
  setPtyHostBindings({})
})
