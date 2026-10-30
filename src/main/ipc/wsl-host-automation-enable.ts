/** A WSL move's last host step: the moved automations go back on, through the host's own API. */
import { z } from 'zod'
import { encodePairingOffer, parsePairingCode } from '../../shared/pairing'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { sendSupportedMigrationRequest } from '../ssh/orcad-migration-catalog-client'
import { getWslHostService } from '../wsl/wsl-host-service-instance'
import type { WslMoveMovedAutomation } from '../persistence/moving-wsl-projects/wsl-move-host-automations-rewrite'

// The host's automation service message for an id it does not hold.
export const AUTOMATION_NOT_FOUND = 'Automation not found'

export const ShownAutomationSchema = z.object({
  automation: z.object({ enabled: z.boolean(), updatedAt: z.number() })
})

export type WslHostAutomationApi = (
  method: 'automation.show' | 'automation.update',
  params: unknown
) => ReturnType<typeof sendSupportedMigrationRequest>

/** The host's automation API, never booting its distro; throws when the host is not reachable. */
export async function openWslHostAutomationApi(
  userDataPath: string,
  environmentId: string
): Promise<WslHostAutomationApi> {
  const service = getWslHostService()
  if (!service?.recordForEnvironment(environmentId)) {
    throw new Error('wsl_move_host_unavailable')
  }
  await service.ensureForRuntimeCall(environmentId)
  const environment = resolveEnvironment(userDataPath, environmentId)
  const pairing = parsePairingCode(encodePairingOffer(getPreferredPairingOffer(environment)))
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const options = environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  return (method, params) => sendSupportedMigrationRequest(pairing, method, params, options)
}

export async function enableWslHostAutomations(
  userDataPath: string,
  environmentId: string,
  automations: readonly WslMoveMovedAutomation[]
): Promise<void> {
  const request = await openWslHostAutomationApi(userDataPath, environmentId)
  for (const moved of automations) {
    const shown = await request('automation.show', { id: moved.id })
    if (!shown.ok) {
      // Deleted on the host since the move: nothing left to turn on.
      if (shown.error.message.includes(AUTOMATION_NOT_FOUND)) {
        continue
      }
      throw new Error(`wsl_move_automation_read_failed:${shown.error.message}`)
    }
    const row = ShownAutomationSchema.parse(shown.result).automation
    // On already, or edited on the host since the move: the host's state is the user's choice.
    if (row.enabled || moved.updatedAt === null || row.updatedAt !== moved.updatedAt) {
      continue
    }
    const updated = await request('automation.update', { id: moved.id, updates: { enabled: true } })
    if (!updated.ok) {
      throw new Error(`wsl_move_automation_enable_failed:${updated.error.message}`)
    }
  }
}
