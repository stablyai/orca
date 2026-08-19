import { unwrapHerdrResponse } from './herdr-runtime-contract'
import type { HerdrHostTransport, HerdrTerminalController } from './herdr-runtime-contract'
import type { HerdrPtyBinding } from './herdr-pty-types'

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
