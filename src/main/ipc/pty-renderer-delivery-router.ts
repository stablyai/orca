import type { PtyDataEvent } from '../providers/pty-provider-events'
import type { TerminalLostWorkerRendererReceipt } from '../../shared/terminal-archive-types'

export type ExternalPtyRendererDeliveryRouter = {
  data(payload: PtyDataEvent): void
  replay(payload: { id: string; data: string }): void
  exit(payload: {
    id: string
    code: number
    lostWorkerRecovery?: TerminalLostWorkerRendererReceipt
  }): void
}

function returnUnroutedCredit(payload: PtyDataEvent): void {
  payload.upstreamCredit?.acknowledge(payload.upstreamCredit.charCount)
}

let router: ExternalPtyRendererDeliveryRouter = {
  data: returnUnroutedCredit,
  replay: () => {},
  exit: () => {}
}

export function installExternalPtyRendererDeliveryRouter(
  nextRouter: ExternalPtyRendererDeliveryRouter
): void {
  router = nextRouter
}

export function routeExternalPtyData(payload: PtyDataEvent): void {
  router.data(payload)
}

export function routeExternalPtyReplay(payload: { id: string; data: string }): void {
  router.replay(payload)
}

export function routeExternalPtyExit(payload: {
  id: string
  code: number
  lostWorkerRecovery?: TerminalLostWorkerRendererReceipt
}): void {
  router.exit(payload)
}
