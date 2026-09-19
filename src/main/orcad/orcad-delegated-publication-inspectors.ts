import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import { inspectOrcadPublishedDestinationActivation } from './orcad-delegated-activation'
import { inspectOrcadPublishedDestinationOutputCoverage } from './orcad-delegated-output-coverage'

type ActivationOptions = Parameters<typeof inspectOrcadPublishedDestinationActivation>[0]

export function createOrcadDelegatedPublicationInspectors(
  options: Pick<ActivationOptions, 'registry' | 'supervisor'> & {
    signal: AbortSignal
    waitForDestinationCommit: (
      identity: PtyOwnershipTransferWireIdentity,
      signal: AbortSignal
    ) => Promise<ActivationOptions['connection']>
  }
) {
  const prepare = async (
    requestedIdentity: PtyOwnershipTransferWireIdentity,
    requestSignal: AbortSignal
  ) => {
    const identity = Object.freeze(parsePtyOwnershipTransferWireIdentity(requestedIdentity))
    const signal = AbortSignal.any([options.signal, options.supervisor.signal, requestSignal])
    const connection = await options.waitForDestinationCommit(identity, signal)
    return {
      identity,
      signal,
      connection,
      registry: options.registry,
      supervisor: options.supervisor
    }
  }
  return {
    inspectPublishedDestinationActivation: async (
      identity: PtyOwnershipTransferWireIdentity,
      signal: AbortSignal
    ) => inspectOrcadPublishedDestinationActivation(await prepare(identity, signal)),
    inspectPublishedDestinationOutputCoverage: async (
      identity: PtyOwnershipTransferWireIdentity,
      throughSeq: number,
      signal: AbortSignal
    ) =>
      inspectOrcadPublishedDestinationOutputCoverage({
        ...(await prepare(identity, signal)),
        throughSeq
      })
  }
}
