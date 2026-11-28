import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { appendUsageLimitedTurn } from './structured-agent-session-usage-limited-turn.test-fixture'

const RESET = NOW + 60 * 60_000
let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

// A bot's replaced Home Chat is closed, and is loaded again after its close (its queued messages
// move to the new Chat): what that load publishes is what every client's bot row then reads.
it('publishes no usage-limit stop for a closed chat, and its state again once reopened', async () => {
  rig = await createQueuedMessageTestRig({
    usageLimitAutoContinue: {
      isEnabled: () => false,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {}
    }
  })
  const { host, store } = rig
  await eventually(() =>
    expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
  )
  // What a client's bot row reads: the last status the feed sent it for this chat.
  let seen: AgentSessionStatusSummary | undefined
  host.subscribeStatus({
    id: 'bot-row',
    emit: (event) => {
      if (event.type === 'status' && event.session.sessionId === SESSION) {
        seen = event.session
      }
    }
  })
  await host.setSessionTabVisibility(SESSION, true)
  const { journal } = await host.conversation(SESSION)
  const fence = store.getRecord(SESSION)!.lease.runtimeFence
  await appendUsageLimitedTurn(journal, { fence, resetsAt: RESET })
  const off = { turnItemId: expect.any(String), resetsAt: RESET, state: 'off' }
  host.collaboratorsForTests().clientDelivery.publishStatus(SESSION)
  await eventually(() => expect(seen?.usageLimitContinue).toEqual(off))

  // As a bot's /new or agent change does: close it, retire its tab, then load it to move its queue.
  await host.close(SESSION, 'evict')
  await host.setSessionTabVisibility(SESSION, false)
  seen = undefined
  await host.conversation(SESSION)
  await vi.waitFor(
    () => {
      expect(seen?.sessionId).toBe(SESSION)
      expect(seen?.usageLimitContinue).toBeUndefined()
    },
    { timeout: 1_000 }
  )

  // Reopening its tab publishes at once: well before the 10 s sweep, with no journal event.
  await host.setSessionTabVisibility(SESSION, true)
  await vi.waitFor(() => expect(seen?.usageLimitContinue).toEqual(off), { timeout: 1_000 })
})
