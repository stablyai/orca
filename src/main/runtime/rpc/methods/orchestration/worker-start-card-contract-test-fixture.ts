import { afterEach, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { QueuedMessageTestRig } from '../../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'

export const h = createOrchestrationRpcHarness()

export const COORD = testOrcaSessionId('start-card-caller')

export const WORKER = testOrcaSessionId('start-card-worker')

let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = undefined
  h.cleanup()
  vi.restoreAllMocks()
})

export const fixture = {
  get rig() {
    return rig
  },
  set rig(value: typeof rig) {
    rig = value
  }
}
