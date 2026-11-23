import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { appendRewindUsageLimitedTurn } from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rewind-usage-limit.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW
} from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { readStructuredMailAdmitFacts } from './structured-mailbox-pointer-host'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
})

async function usageLimitedBackgroundChat(enabled: boolean, asleep = false) {
  rig = await createQueuedMessageTestRig({
    now: () => HOST_TEST_NOW,
    usageLimitAutoContinue: {
      isEnabled: () => enabled,
      isWorkspaceAsleep: () => asleep,
      subscribe: () => () => {}
    }
  })
  // Bot and worker chats run without a tab.
  await rig.store.setSessionTabVisibility(SESSION, false, undefined, { background: true })
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const cut = await appendRewindUsageLimitedTurn(journal, HOST_TEST_NOW)
  setStructuredAgentSessionHost(rig.host)
  return cut
}

it("tells a sender that mail to a usage-limited background chat waits for Orca's continue", async () => {
  const cut = await usageLimitedBackgroundChat(true)
  const facts = await readStructuredMailAdmitFacts(SESSION)
  expect(facts).toMatchObject({
    attached: true,
    failedTurn: { usageLimit: { state: 'scheduled', resetsAt: cut.resetsAt } }
  })
})

it('tells a sender when Orca will not continue a usage-limited chat because the setting is off', async () => {
  await usageLimitedBackgroundChat(false)
  const facts = await readStructuredMailAdmitFacts(SESSION)
  expect(facts).toMatchObject({
    attached: true,
    failedTurn: { usageLimit: { state: 'off', off: 'setting' } }
  })
})

it('tells a sender a usage-limited chat waits for its workspace to wake, not for a person', async () => {
  await usageLimitedBackgroundChat(true, true)
  const facts = await readStructuredMailAdmitFacts(SESSION)
  expect(facts).toMatchObject({
    attached: true,
    failedTurn: { usageLimit: { state: 'off', off: 'asleep' } }
  })
})
