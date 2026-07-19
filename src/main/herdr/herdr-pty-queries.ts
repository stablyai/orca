import type { HerdrHostTransport, HerdrPane } from './herdr-runtime-contract'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import type { HerdrPaneProcessInfo, HerdrPtyBinding } from './herdr-pty-types'

export type HerdrPaneDetails = HerdrPane & {
  cwd?: string
  foreground_cwd?: string
  label?: string
  title?: string
  terminal_title?: string
}

export async function getHerdrPane(
  transport: HerdrHostTransport,
  binding: HerdrPtyBinding
): Promise<HerdrPaneDetails> {
  return unwrapHerdrResponse<{ pane: HerdrPaneDetails }>(
    await transport.request(binding.sessionName, 'pane.get', { pane_id: binding.paneId })
  ).pane
}

export async function getHerdrProcessInfo(
  transport: HerdrHostTransport,
  binding: HerdrPtyBinding
): Promise<HerdrPaneProcessInfo> {
  return unwrapHerdrResponse<{ process_info: HerdrPaneProcessInfo }>(
    await transport.request(binding.sessionName, 'pane.process_info', {
      pane_id: binding.paneId
    })
  ).process_info
}
