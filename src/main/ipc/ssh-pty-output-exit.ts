import type { SshPtyLegacyProjectionLedger } from './ssh-pty-legacy-projection'
import type { SshPtyModelAdmission } from './ssh-pty-model-admission'
import type {
  SshPtyOutputExitEvent,
  SshPtyOutputIntakeDependencies
} from './ssh-pty-output-intake-contract'

export async function settleSshPtyOutputExit(args: {
  event: SshPtyOutputExitEvent
  admission: SshPtyModelAdmission
  projections: SshPtyLegacyProjectionLedger
  dependencies: SshPtyOutputIntakeDependencies
  validateGeneration: () => void
  prepareExit?: () => void
  afterAdmissionIdle?: () => void
  waitForSourceTerminal?: () => Promise<void>
  beforeFinalize?: () => void
}): Promise<void> {
  const {
    event,
    admission,
    projections,
    dependencies,
    validateGeneration,
    prepareExit,
    afterAdmissionIdle,
    waitForSourceTerminal,
    beforeFinalize
  } = args
  await admission.whenIdle({
    ptyId: event.id,
    providerGeneration: event.providerGeneration
  })
  validateGeneration()
  afterAdmissionIdle?.()
  try {
    if (prepareExit) {
      prepareExit()
    } else {
      dependencies.prepareExit(event)
    }
  } catch (error) {
    projections.closePty(
      event.id,
      event.providerGeneration,
      event.ptyIncarnation,
      'pty-exit-finalize-failed'
    )
    dependencies.closeProvider?.(event.providerGeneration, 'pty-exit-finalize-failed')
    throw error
  }
  projections.transferUnpublishedPty(
    event.id,
    event.providerGeneration,
    event.ptyIncarnation,
    'pty-exit-unpublished'
  )
  await projections.whenPtyTerminal(event.id, event.providerGeneration, event.ptyIncarnation)
  await waitForSourceTerminal?.()
  validateGeneration()
  try {
    beforeFinalize?.()
    dependencies.finalizeExit(event)
    projections.closePty(event.id, event.providerGeneration, event.ptyIncarnation, 'pty-exit')
  } catch (error) {
    projections.closePty(
      event.id,
      event.providerGeneration,
      event.ptyIncarnation,
      'pty-exit-finalize-failed'
    )
    dependencies.closeProvider?.(event.providerGeneration, 'pty-exit-finalize-failed')
    throw error
  }
}
