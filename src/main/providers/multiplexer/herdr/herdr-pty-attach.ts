import { unwrapHerdrResponse } from './herdr-runtime-contract'
import type { HerdrHostTransport, HerdrTerminalController } from './herdr-runtime-contract'
import type { HerdrPtyBinding } from './herdr-pty-types'

const sizePulses = new WeakMap<HerdrPtyBinding, HerdrTerminalController>()

export function openSharedHerdrPaneController(
  transport: HerdrHostTransport,
  sessionName: string,
  paneId: string,
  size: { cols: number; rows: number }
): HerdrTerminalController {
  if (!transport.controlTerminal) {
    throw new Error('Herdr host transport does not support terminal control')
  }
  // Why: the Herdr TUI is the exclusive attach. Orca observes frames and types
  // through pane.send_text so either client can open first.
  return transport.controlTerminal(sessionName, paneId, { ...size, observe: true })
}

export async function writeSharedHerdrInput(binding: HerdrPtyBinding, data: string): Promise<void> {
  unwrapHerdrResponse(
    await binding.transport.request(binding.sessionName, 'pane.send_text', {
      pane_id: binding.paneId,
      text: data
    })
  )
}

export function cancelHerdrPaneSizePulse(binding: HerdrPtyBinding): void {
  const pulse = sizePulses.get(binding)
  if (!pulse) {
    return
  }
  sizePulses.delete(binding)
  pulse.release()
}

export function applyHerdrPaneSize(binding: HerdrPtyBinding): void {
  if (binding.detached || binding.cols < 1 || binding.rows < 1) {
    return
  }
  if (!binding.transport.controlTerminal) {
    return
  }
  if (sizePulses.has(binding)) {
    return
  }
  // Why: observe cannot change PTY size. A short exclusive attach without
  // --takeover sets cols/rows, then releases so a Herdr TUI can still attach.
  const cols = binding.cols
  const rows = binding.rows
  const exclusive = binding.transport.controlTerminal(binding.sessionName, binding.paneId, {
    cols,
    rows
  })
  sizePulses.set(binding, exclusive)
  let offFrame = (): void => {}
  let offClosed = (): void => {}
  let timeout: ReturnType<typeof setTimeout> | undefined
  const finish = (): void => {
    if (sizePulses.get(binding) !== exclusive) {
      return
    }
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
    offFrame()
    offClosed()
    sizePulses.delete(binding)
    exclusive.release()
    if (!binding.detached && (binding.cols !== cols || binding.rows !== rows)) {
      applyHerdrPaneSize(binding)
    }
  }
  timeout = setTimeout(finish, 2_000)
  offFrame = exclusive.onFrame(() => {
    exclusive.resize(binding.cols, binding.rows)
    finish()
  })
  offClosed = exclusive.onClosed(() => {
    finish()
  })
}
