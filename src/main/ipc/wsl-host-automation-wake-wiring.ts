/** Production wiring for the E9 automation wake: host automations over runtime RPC, a userData file. */
import type { Automation } from '../../shared/automations-types'
import {
  readWslHostAutomationWakes,
  WslHostAutomationWake,
  writeWslHostAutomationWakes
} from '../wsl/wsl-host-automation-wake'
import type { WslHostService } from '../wsl/wsl-host-service'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import { onWslOrcadHostAutomationsChanged } from '../wsl/wsl-orcad-host-environments'

// A connected host's schedule can change from any client; re-read it this often.
const RELEARN_MS = 15 * 60 * 1000

export function createWslHostAutomationWake(
  userDataPath: () => string,
  service: WslHostService
): WslHostAutomationWake {
  const wake = new WslHostAutomationWake({
    load: () => readWslHostAutomationWakes(userDataPath()),
    save: (due) => writeWslHostAutomationWakes(userDataPath(), due),
    listAutomations: async (environmentId) => {
      const response = await callRuntimeEnvironment(
        userDataPath(),
        environmentId,
        'automation.list',
        undefined
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const result = response.result
      return result && typeof result === 'object' && 'automations' in result
        ? automationsFrom(result.automations)
        : []
    },
    isConnected: (environmentId) => service.isConnected(environmentId),
    wake: (environmentId) => service.wakeForAutomation(environmentId)
  })
  const relearn = setInterval(() => {
    for (const status of service.getStatuses()) {
      if (status.state === 'ready') {
        void wake.learn(status.environmentId)
      }
    }
  }, RELEARN_MS)
  relearn.unref?.()
  // A deleted, disabled or rescheduled automation must not keep its old wake time.
  onWslOrcadHostAutomationsChanged((environmentId) => void wake.learn(environmentId))
  wake.start()
  return wake
}

/** Only rows carrying what the wake reads; anything else from an odd host is ignored. */
function automationsFrom(value: unknown): Automation[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter(
    (row): row is Automation =>
      Boolean(row) &&
      typeof row === 'object' &&
      typeof row.enabled === 'boolean' &&
      typeof row.rrule === 'string' &&
      typeof row.dtstart === 'number' &&
      typeof row.nextRunAt === 'number' &&
      typeof row.missedRunGraceMinutes === 'number'
  )
}
