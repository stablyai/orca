import type { IPtyProvider } from '../../../providers/types'
import { ptyIncarnationById } from './ownership-state'
import type { PtyKillIntent } from '../../../../shared/pty-kill-sessions'
import type { PtyShutdownResult } from '../../../providers/pty-provider-contract'

export async function shutdownProviderAndDetectOutcome(
  provider: IPtyProvider,
  id: string,
  opts: {
    immediate?: boolean
    keepHistory?: boolean
    deadlineMs?: number
    intent?: PtyKillIntent
    incarnationId?: string
  }
): Promise<{ providerExitObserved: boolean; result: PtyShutdownResult | void }> {
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
    const result = provider.shutdownWithOutcome
      ? await provider.shutdownWithOutcome(id, opts)
      : (await provider.shutdown(id, opts), undefined)
    return { providerExitObserved, result }
  } finally {
    unsubscribe()
  }
}

export async function shutdownProviderAndDetectExit(
  provider: IPtyProvider,
  id: string,
  opts: {
    immediate?: boolean
    keepHistory?: boolean
    deadlineMs?: number
    intent?: PtyKillIntent
    incarnationId?: string
  }
): Promise<boolean> {
  return (await shutdownProviderAndDetectOutcome(provider, id, opts)).providerExitObserved
}
