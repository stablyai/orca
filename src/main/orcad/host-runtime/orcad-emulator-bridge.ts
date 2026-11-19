import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { BackendServiceCleanup } from '../../backend/service-composition'
import { EmulatorBridge } from '../../emulator/emulator-bridge'

// A stalled adb must not hold the final profile flush past orcad's shutdown deadline.
const EMULATOR_TEARDOWN_BUDGET_MS = 3_000

/** Android drives adb/emulator on any host; iOS backends report their own host-support errors. */
export function installOrcadEmulatorBridge(
  runtime: OrcaRuntimeService,
  registerCleanup: (cleanup: BackendServiceCleanup) => void
): void {
  const bridge = new EmulatorBridge()
  runtime.setEmulatorBridge(bridge)
  // Like desktop quit: stop the helpers and devices Orca started.
  registerCleanup(async () => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        bridge.destroyAllSessions({
          deadline: performance.now() + EMULATOR_TEARDOWN_BUDGET_MS,
          signal: controller.signal
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('Emulator shutdown drain timed out; ownership may be retained.'))
          }, EMULATOR_TEARDOWN_BUDGET_MS)
          timer.unref?.()
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  })
}
