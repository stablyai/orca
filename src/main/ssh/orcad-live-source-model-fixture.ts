import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import { SshPtyOutputIntake, type SshPtyOutputDataEvent } from '../ipc/ssh-pty-output-intake'
import {
  allocateSshPtyProviderGeneration,
  installSshPtyOutputIntake
} from '../ipc/ssh-pty-output-intake-registry'
import { registerSshPtyProvider, unregisterSshPtyProvider } from '../ipc/pty/provider/registry'

export function installLiveSourceModel(
  runtime: OrcaRuntimeService,
  mux: SshChannelMultiplexer,
  targetId: string,
  owner: { ownerLease: string; ownerGeneration: number }
) {
  const provider = new SshPtyProvider(
    targetId,
    mux,
    undefined,
    allocateSshPtyProviderGeneration(),
    {
      getOwnershipTransferOwner: () => ({
        ownerLease: owner.ownerLease,
        sourceOwnerGeneration: owner.ownerGeneration
      })
    }
  )
  const errors: unknown[] = []
  let ready = false
  let pending = Promise.resolve()
  const early: SshPtyOutputDataEvent[] = []
  const intake = new SshPtyOutputIntake({
    getModelSequence: (id) => runtime.getPtyOutputSequence(id),
    acceptModel: (event, projection) =>
      runtime.acceptPtyDataBounded(
        event.id,
        event.data,
        Date.now(),
        event.rawLength,
        event.transformed,
        projection.desktopSpan ? [projection.desktopSpan] : undefined
      ),
    // This headless harness transfers renderer obligations; it does not simulate parse ACKs.
    project: (_event, projection) => {
      intake.transferProjections([projection.identity.projectionSemanticsId], 'test-no-renderer')
    },
    prepareExit: () => {},
    finalizeExit: (event) =>
      runtime.onPtyExit(event.id, event.code, event.ptyIncarnation, { hostExitConfirmed: true }),
    publishSourceAck: (_generation, batch, onSettled) => {
      mux.notifyWithSettlement('pty.ackData', batch, (settlement) => {
        onSettled(
          settlement.outcome === 'accepted' ? { ok: true } : { ok: false, error: settlement.error }
        )
      })
    }
  })
  const removeIntake = installSshPtyOutputIntake(intake)
  registerSshPtyProvider(targetId, provider)
  const accept = (event: SshPtyOutputDataEvent) => {
    pending = pending
      .then(async () => {
        await intake.acceptData(event)
      })
      .catch((error) => {
        errors.push(error)
      })
  }
  const removeData = provider.onData((payload) => {
    const event = {
      ...payload,
      rawLength: payload.sequenceChars ?? payload.data.length,
      transformed: payload.transformed === true,
      sequence: payload.seq
    }
    if (ready) {
      accept(event)
    } else {
      early.push(event)
    }
  })
  return {
    provider,
    errors,
    ready: () => {
      ready = true
      early.splice(0).forEach(accept)
    },
    drain: () => pending,
    dispose: () => {
      removeData()
      unregisterSshPtyProvider(targetId)
      provider.dispose()
      removeIntake()
    }
  }
}
