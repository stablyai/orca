import { unwrapHerdrResponse } from './herdr-runtime-contract'
import type {
  HerdrHostTransport,
  HerdrTerminalController,
  HerdrTerminalFrame
} from './herdr-runtime-contract'
import type { HerdrPtyBinding } from './herdr-pty-types'

export function isHerdrAttachBusy(reason: string): boolean {
  return /already has an attached client|retry with --takeover/i.test(reason)
}

function replayFirstFrame(
  controller: HerdrTerminalController,
  first: HerdrTerminalFrame
): HerdrTerminalController {
  return {
    write: (data) => controller.write(data),
    resize: (cols, rows) => controller.resize(cols, rows),
    release: () => controller.release(),
    onFrame: (listener) => {
      listener(first)
      return controller.onFrame(listener)
    },
    onClosed: (listener) => controller.onClosed(listener)
  }
}

function firstControllerEvent(
  controller: HerdrTerminalController
): Promise<{ kind: 'frame'; frame: HerdrTerminalFrame } | { kind: 'closed'; reason: string }> {
  return new Promise((resolve) => {
    let settled = false
    let offFrame = (): void => {}
    let offClosed = (): void => {}
    const finish = (
      value: { kind: 'frame'; frame: HerdrTerminalFrame } | { kind: 'closed'; reason: string }
    ): void => {
      if (settled) {
        return
      }
      settled = true
      offFrame()
      offClosed()
      resolve(value)
    }
    offFrame = controller.onFrame((frame) => finish({ kind: 'frame', frame }))
    offClosed = controller.onClosed((event) => finish({ kind: 'closed', reason: event.reason }))
  })
}

export async function openSharedHerdrPaneController(
  transport: HerdrHostTransport,
  sessionName: string,
  paneId: string,
  size: { cols: number; rows: number }
): Promise<{ controller: HerdrTerminalController; sharedAttach: boolean }> {
  if (!transport.controlTerminal) {
    throw new Error('Herdr host transport does not support terminal control')
  }
  const exclusive = transport.controlTerminal(sessionName, paneId, size)
  const first = await firstControllerEvent(exclusive)
  if (first.kind === 'frame') {
    return { controller: replayFirstFrame(exclusive, first.frame), sharedAttach: false }
  }
  exclusive.release()
  if (!isHerdrAttachBusy(first.reason)) {
    throw new Error(first.reason || 'Herdr terminal controller closed before its first frame')
  }
  return {
    controller: transport.controlTerminal(sessionName, paneId, { ...size, observe: true }),
    sharedAttach: true
  }
}

export async function writeSharedHerdrInput(binding: HerdrPtyBinding, data: string): Promise<void> {
  unwrapHerdrResponse(
    await binding.transport.request(binding.sessionName, 'pane.send_text', {
      pane_id: binding.paneId,
      text: data
    })
  )
}
