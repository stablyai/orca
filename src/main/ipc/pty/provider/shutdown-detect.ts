import type { IPtyProvider, PtyShutdownEvidence } from '../../../providers/pty-provider-contract'
import { ptyIncarnationById } from './ownership-state'

export type ObservedPtyShutdownOptions = Parameters<IPtyProvider['shutdown']>[1] & {
  establishedOwnerOnly?: true
  onExitEvidence?: (evidence: PtyShutdownEvidence) => void
}

export async function shutdownProviderAndDetectExit(
  provider: IPtyProvider,
  id: string,
  opts: ObservedPtyShutdownOptions
): Promise<boolean> {
  return (await shutdownProviderWithExitEvidence(provider, id, opts)).observed
}

export async function shutdownProviderWithExitEvidence(
  provider: IPtyProvider,
  id: string,
  opts: ObservedPtyShutdownOptions
): Promise<{ observed: boolean; confirmed: boolean; allowAbsenceProof: boolean }> {
  let providerExitObserved = false
  let hostConfirmed = false
  let allowAbsenceProof = true
  const expectedIncarnationId = opts.expectedIncarnationId ?? ptyIncarnationById.get(id)
  const unsubscribe = provider.onExit?.((payload) => {
    if (
      payload.id === id &&
      (!expectedIncarnationId || payload.incarnationId === expectedIncarnationId)
    ) {
      providerExitObserved = true
    }
  })
  try {
    const { establishedOwnerOnly, onExitEvidence, ...shutdownOptions } = opts
    if (
      establishedOwnerOnly &&
      provider.resolveEstablishedShutdownOwner &&
      !opts.expectedIncarnationId
    ) {
      onExitEvidence?.({ confirmed: false, allowAbsenceProof: false })
      throw new Error('Terminal shutdown incarnation is unverified')
    }
    const elected =
      establishedOwnerOnly && opts.expectedIncarnationId && provider.resolveEstablishedShutdownOwner
        ? provider.resolveEstablishedShutdownOwner(id, opts.expectedIncarnationId)
        : undefined
    if (elected === null) {
      opts.onExitEvidence?.({ confirmed: false, allowAbsenceProof: false })
      throw new Error('Terminal shutdown owner is unverified')
    }
    const owner = elected?.provider ?? provider
    elected?.assertCurrent()
    if (
      opts.expectedIncarnationId &&
      owner.killFenced &&
      owner.supportsFencedTermination?.(id) === true &&
      opts.immediate &&
      !opts.keepHistory &&
      !opts.expectedOwnerClientInstanceId
    ) {
      onExitEvidence?.({ confirmed: false, allowAbsenceProof: false })
      const result = await owner.killFenced(
        {
          id,
          expectedIncarnationId: opts.expectedIncarnationId,
          requireNoAgentOwner: false,
          requireUnattached: false
        },
        elected?.assertCurrent
      )
      if (result.outcome === 'refused') {
        throw new Error(`Terminal shutdown was not confirmed: ${result.reason}`)
      }
      hostConfirmed = true
    } else {
      allowAbsenceProof = !owner.killFenced
      opts.onExitEvidence?.({ confirmed: false, allowAbsenceProof })
      await owner.shutdown(id, {
        ...shutdownOptions,
        ...(elected ? { assertCurrent: elected.assertCurrent } : {})
      })
      elected?.assertCurrent(true)
      if (!opts.keepHistory) {
        elected?.release()
      }
    }
    elected?.assertCurrent(true)
  } finally {
    unsubscribe?.()
  }
  const result = {
    observed: providerExitObserved,
    confirmed: hostConfirmed || providerExitObserved,
    allowAbsenceProof
  }
  opts.onExitEvidence?.(result)
  return result
}
