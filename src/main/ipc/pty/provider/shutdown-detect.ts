import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { PtyExitProof } from '../../../pty/process-retirement/pty-exit-proof'
import { ptyIncarnationById } from './ownership-state'

export class PtyRetirementRefusedBeforeSignal extends Error {}

export async function shutdownPtyIncarnation(
  provider: IPtyProvider,
  id: string,
  expectedIncarnationId: string,
  keepHistory: boolean,
  authorize?: () => void
): Promise<PtyExitProof> {
  const currentIncarnation = ptyIncarnationById.get(id)
  if (currentIncarnation && currentIncarnation !== expectedIncarnationId) {
    throw new Error('terminal_pane_owner_changed')
  }
  const request = {
    id,
    expectedIncarnationId,
    requireNoAgentOwner: false,
    requireUnattached: false,
    keepHistory
  }
  if (!provider.killFenced) {
    throw new Error('terminal_replaced_pty_stop_unverified')
  }
  let authorityError: unknown
  const checkAuthority = authorize
    ? () => {
        try {
          authorize()
        } catch (error) {
          authorityError = error
          throw error
        }
      }
    : undefined
  const result = await provider.killFenced(request, checkAuthority)
  if (authorityError) {
    throw authorityError
  }
  if (result.outcome === 'refused') {
    const Refusal = result.reason === 'unverifiable' ? Error : PtyRetirementRefusedBeforeSignal
    throw new Refusal(
      result.reason === 'replaced'
        ? 'terminal_pane_owner_changed'
        : 'terminal_replaced_pty_stop_unverified'
    )
  }
  return PtyExitProof.from(
    result.outcome === 'ended' ? 'stop-confirmed' : 'absent',
    expectedIncarnationId
  )
}

export async function shutdownProviderAndDetectExit(
  provider: IPtyProvider,
  id: string,
  opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
): Promise<boolean> {
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
    await provider.shutdown(id, opts)
  } finally {
    unsubscribe()
  }
  return providerExitObserved
}
