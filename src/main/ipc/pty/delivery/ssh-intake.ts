import type { IPtyProvider } from '../../../providers/types'
import { SshPtyOutputIntake } from '../../ssh-pty-output-intake'
import {
  cancelSshPtySourceDelivery,
  installSshPtyOutputIntake,
  publishSshPtySourceAck
} from '../../ssh-pty-output-intake-registry'
import { sshProvidersByGeneration } from '../provider/registry'
import { setSshOutputIntakeCleanup, sshOutputIntakeCleanup } from '../provider/listener-lifecycle'
import type { PtyIpcSession } from '../session'

export function installSessionSshOutputIntake(session: PtyIpcSession): void {
  sshOutputIntakeCleanup?.()
  session.sshOutputIntake = new SshPtyOutputIntake({
    getModelSequence: (id) => session.runtime?.getPtyOutputSequence(id) ?? 0,
    acceptModel: (event, projection) => {
      if (!session.runtime) {
        throw new Error('SSH PTY output requires the main terminal model')
      }
      return session.runtime.acceptPtyDataBounded(
        event.id,
        event.data,
        Date.now(),
        event.rawLength,
        event.transformed,
        projection.desktopSpan ? [projection.desktopSpan] : undefined
      )
    },
    project: (event, projection) =>
      session.acceptPtyDataForRenderer(
        {
          id: event.id,
          data: event.data,
          sequenceChars: event.rawLength,
          transformed: event.transformed
        },
        projection.identity.sequenceEnd,
        projection
      ),
    prepareExit: (event) => {
      const release = session.preparePtyExitForRenderer(event)
      if (!release) {
        throw new Error('pty_renderer_exit_in_progress')
      }
      return release
    },
    finalizeExit: (event) => {
      session.runtime?.onPtyExit(event.id, event.code, event.ptyIncarnation, {
        hostExitConfirmed: true
      })
      session.finalizePtyExitForRenderer(event)
    },
    pauseProvider: (generation, id) => {
      const provider = sshProvidersByGeneration.get(generation) as
        | (IPtyProvider & { hasPtyDeliveryPauseAdapter?: () => boolean })
        | undefined
      if (!provider?.hasPtyDeliveryPauseAdapter?.()) {
        return false
      }
      provider.pauseProducer?.(id)
      return true
    },
    resumeProvider: (generation, id) =>
      sshProvidersByGeneration.get(generation)?.resumeProducer?.(id),
    closeProvider: (generation, reason) => {
      const provider = sshProvidersByGeneration.get(generation)
      ;(
        provider as (IPtyProvider & { closeOutputIntake?: (reason: string) => void }) | undefined
      )?.closeOutputIntake?.(reason)
    },
    resetModelForMigration: (_generation, id) =>
      session.runtime?.resetPtyModelAfterMigrationFailure(id),
    onGenerationClosed: (providerGeneration) => {
      for (const id of session.pendingData.keys()) {
        const pending = session.pendingData.get(id)
        if (
          pending?.projectionAdmissionIds &&
          session.sshOutputIntake?.hasProjectionFromGeneration(
            pending.projectionAdmissionIds,
            providerGeneration
          )
        ) {
          session.pendingData.delete(id)
          session.updateProducerFlowControl(id)
          session.pendingOverflowMarkedPtys.delete(id)
        }
      }
      sshProvidersByGeneration.delete(providerGeneration)
    },
    publishSourceAck: publishSshPtySourceAck,
    cancelSourceDelivery: cancelSshPtySourceDelivery
  })
  session.runtime?.setRemoteTerminalSourceRangeConsumerHooks?.(
    session.sshOutputIntake.getRemoteSourceRangeConsumerHooks()
  )
  const cleanupSshOutputIntakeRegistry = installSshPtyOutputIntake(session.sshOutputIntake)
  setSshOutputIntakeCleanup(() => {
    session.runtime?.setRemoteTerminalSourceRangeConsumerHooks?.(null)
    cleanupSshOutputIntakeRegistry()
  })
}
