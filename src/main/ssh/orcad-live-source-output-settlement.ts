import {
  getSshPtyAcceptedSourceCheckpoints,
  requireSshPtyLiveSourceSettlement
} from '../ipc/ssh-pty-output-intake-registry'
import type { bindOutgoingOrcadIncumbent } from './orcad-outgoing-source-binding'
import { samePtySourceDelivery } from '../../shared/pty-source-credit-contract'

type BoundSource = Pick<
  ReturnType<typeof bindOutgoingOrcadIncumbent>,
  'ptyId' | 'identity' | 'providerGeneration'
>

/** Current local output only; does not fence ingress or acknowledge durable route retirement. */
export function inspectOrcadLiveSourceOutputSettlements(
  sources: readonly BoundSource[],
  assertCurrent: () => void
) {
  assertCurrent()
  const checkpoints = sources.map(sourceCheckpoint)
  const settlements = checkpoints.map((checkpoint) => requireSshPtyLiveSourceSettlement(checkpoint))
  assertCurrent()
  for (const [index, checkpoint] of checkpoints.entries()) {
    const current = sourceCheckpoint(sources[index])
    if (
      !samePtySourceDelivery(checkpoint, current) ||
      checkpoint.acceptedSourceEndSu !== current.acceptedSourceEndSu
    ) {
      throw new Error('orcad_live_source_output_changed')
    }
    requireSshPtyLiveSourceSettlement(checkpoint)
  }
  return Object.freeze(settlements)
}

function sourceCheckpoint(source: BoundSource) {
  const matches = getSshPtyAcceptedSourceCheckpoints(source.providerGeneration).filter(
    (checkpoint) => checkpoint.id === source.ptyId
  )
  if (
    matches.length !== 1 ||
    matches[0].providerGeneration !== source.providerGeneration ||
    matches[0].ptyIncarnation !== source.identity.incarnationId
  ) {
    throw new Error('orcad_live_source_output_identity_unverifiable')
  }
  return matches[0]
}
