import { vi } from 'vitest'
import {
  createSshPtyOutputIntakeHarness,
  sshPtyOutputEvent
} from '../ipc/ssh-pty-output-intake-test-harness'
import {
  installSshPtyOutputIntake,
  requireSshPtyLiveSourceSettlement
} from '../ipc/ssh-pty-output-intake-registry'
import type { inspectOrcadLiveSourceOutputSettlements } from './orcad-live-source-output-settlement'

export async function liveSourceOutputFixture(
  sources: Parameters<typeof inspectOrcadLiveSourceOutputSettlements>[0]
) {
  const output = createSshPtyOutputIntakeHarness({
    publishSourceAck: (_generation, _batch, settled) => settled({ ok: true })
  })
  const uninstall = installSshPtyOutputIntake(output.intake)
  try {
    for (const [index, source] of sources.entries()) {
      const pending = output.intake.acceptData(
        sshPtyOutputEvent({
          id: source.ptyId,
          providerGeneration: source.providerGeneration,
          ptyIncarnation: source.identity.incarnationId,
          source: {
            relayPtyId: source.identity.terminalId,
            spanId: `span-${index}`,
            clientGeneration: 1,
            ownerGeneration: source.identity.sourceOwnerGeneration,
            deliveryToken: `token-${index}`,
            sourceStartSu: 0,
            sourceEndSu: 4
          }
        })
      )
      output.completions[index].resolve()
      const receipt = await pending
      output.intake.publishProjectionPrefix(
        [receipt.projection.identity.projectionSemanticsId],
        4,
        4
      )
      output.intake.settleProjectionPrefix(source.ptyId, 4)
    }
    await vi.waitFor(() => {
      for (const source of sources) {
        const checkpoint = output.intake
          .getAcceptedSourceCheckpoints(source.providerGeneration)
          .find((entry) => entry.id === source.ptyId)!
        requireSshPtyLiveSourceSettlement(checkpoint)
      }
    })
    return { ...output, uninstall }
  } catch (error) {
    uninstall()
    throw error
  }
}
