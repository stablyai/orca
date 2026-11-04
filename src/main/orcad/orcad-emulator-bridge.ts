import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'
import { EmulatorBridge } from '../emulator/emulator-bridge'
import { withTimeout } from '../../shared/promise-timeout-fallback'

// A stalled adb must not hold the final profile flush past orcad's shutdown deadline.
const EMULATOR_TEARDOWN_BUDGET_MS = 3_000

/** Android drives adb/emulator on any host; iOS backends report their own host-support errors. */
export function installOrcadEmulatorBridge(
  runtime: OrcaRuntimeService,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): void {
  const bridge = new EmulatorBridge()
  runtime.setEmulatorBridge(bridge)
  // Like desktop quit: stop the helpers and devices Orca started.
  registerCleanup(() =>
    withTimeout(bridge.destroyAllSessions(), EMULATOR_TEARDOWN_BUDGET_MS, undefined)
  )
}
