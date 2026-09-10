import type { IPtyProvider } from '../../../providers/types'
import { parsePtyStopReceipt, type PtyStopReceipt } from '../../../../shared/pty-stop-receipt'
import { ptyIncarnationById } from './ownership-state'

export type PtyProviderShutdownResult = {
  receipt: PtyStopReceipt
  providerExitObserved: boolean
}

export async function shutdownProviderAndDetectExit(
  provider: IPtyProvider,
  id: string,
  opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
): Promise<PtyProviderShutdownResult> {
  let providerExitObserved = false
  const expectedIncarnationId = ptyIncarnationById.get(id)
  const unsubscribe = provider.onExit((payload) => {
    if (
      payload.id === id &&
      (!expectedIncarnationId || payload.incarnationId === expectedIncarnationId)
    ) {
      providerExitObserved = true
    }
  })
  try {
    const receipt = await provider.shutdown(
      id,
      expectedIncarnationId ? { ...opts, expectedIncarnationId } : opts
    )
    return {
      receipt: parsePtyStopReceipt(receipt, {
        ptyId: id,
        ...(expectedIncarnationId ? { ptyIncarnation: expectedIncarnationId } : {})
      }),
      providerExitObserved
    }
  } finally {
    unsubscribe()
  }
}
