/** A WSL move's last host step: the moved automations go back on, through the host's own API. */
import { z } from 'zod'
import {
  encodePairingOffer,
  parsePairingCode
} from '../../../shared/remote-runtime/pairing/pairing'
import { getPreferredPairingOffer } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { sendSupportedMigrationRequest } from '../../managed-server/migration/catalog/orcad-migration-request'
import { getWslHostService } from './wsl-host-service-instance'
import { untilWslMoveTurnAborted } from '../../persistence/moving-wsl-projects/cutover-recovery/wsl-move-host-automations-lock'
import type { WslMoveMovedAutomation } from '../../persistence/moving-wsl-projects/desktop-state/wsl-move-host-automations-rewrite'

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
  environmentId: string,
  signal?: AbortSignal
): Promise<WslHostAutomationApi> {
  // The connect waits on wsl.exe and takes no signal; a deadline must still end the wait.
  const bounded = <T>(work: Promise<T>): Promise<T> =>
    signal ? untilWslMoveTurnAborted(work, signal) : work
  const service = getWslHostService()
  if (!service || !(await bounded(service.recordForEnvironment(environmentId)))) {
    throw new Error('wsl_move_host_unavailable')
  }
  await bounded(service.ensureForRuntimeCall(environmentId))
  const environment = await bounded(resolveEnvironment(userDataPath, environmentId))
  const pairing = parsePairingCode(encodePairingOffer(getPreferredPairingOffer(environment)))
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const options = {
    ...(environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}),
    ...(signal ? { signal } : {})
  }
  return (method, params) =>
    bounded(sendSupportedMigrationRequest(pairing, method, params, options))
}

export async function enableWslHostAutomations(
  userDataPath: string,
  environmentId: string,
  automations: readonly WslMoveMovedAutomation[],
  signal?: AbortSignal
): Promise<void> {
  const request = await openWslHostAutomationApi(userDataPath, environmentId, signal)
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
