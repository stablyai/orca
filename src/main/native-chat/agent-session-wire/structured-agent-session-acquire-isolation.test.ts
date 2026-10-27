import { expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { journalIdentityFor } from './structured-agent-session-attach'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { digestPayload } from '../agent-session-journal/journal-payload-bounds'
import {
  CALLER,
  attach,
  attachParams,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'

it("creates a chat while another saved chat's owner check fails", async () => {
  await attach()
  const prior = hostTestState()
  prior.acquire.mockImplementation(async ({ fence, spawnToken }) => ({
    acquisitionGeneration: globalThis.crypto.randomUUID(),
    process: { hostId: 'local', pid: 4242, processStartTimeMs: HOST_TEST_NOW, spawnToken },
    link: {
      linkId: 'new-link',
      handle: codexProviderHandle(HOST_TEST_THREAD),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: HOST_TEST_NOW
    }
  }))
  const peerId = attachParams().envelope.sessionId
  const store = await openTestAgentSessionRecordStore(prior.root)
  const probeOwners = vi.fn(async () => {
    throw new Error('owner check failed')
  })
  const host = new StructuredAgentSessionHost({ ...prior.host.deps, store, probeOwners })
  replaceHostTestState({ store, host })
  const request = attachParams()
  const params = attachParams({
    envelope: { ...request.envelope, sessionId: 'new-chat' },
    accountHome: { variable: 'CODEX_HOME', path: prior.root }
  })

  const result = await host.attach(CALLER, params)

  expect(result.ok, JSON.stringify(result)).toBe(true)
  expect(probeOwners).not.toHaveBeenCalled()
  expect(store.getRecord(peerId)?.lease.unreconciled).toBe(true)
  expect(store.getRecord('new-chat')?.lease.claimStatus).toBe('live')
})

it('keeps a send a crash cut off as sent when its chat reattaches', async () => {
  const record = await attach()
  const prior = hostTestState()
  if (!record) {
    throw new Error('the initial attach did not reserve its chat')
  }
  await prior.host.close(HOST_TEST_SESSION, 'evict')
  const journal = await openAgentSessionJournal({
    identity: journalIdentityFor(record, attachParams()),
    database: openTestJournalHostDatabase(prior.root)
  })
  await journal.appendSubmission({
    clientMessageId: 'crashed-send',
    payloadFingerprint: digestPayload('deploy the thing'),
    body: hostTestMessage('deploy the thing'),
    fence: record.lease.runtimeFence
  })
  await journal.close()

  const store = await openTestAgentSessionRecordStore(prior.root)
  await store.reconcileOnRestart({
    probe: async () => ({ outcome: 'pid-absent' }),
    now: HOST_TEST_NOW + 1
  })
  const host = new StructuredAgentSessionHost({ ...prior.host.deps, store })
  replaceHostTestState({ store, host })

  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? null)
    )
  ).toMatchObject({
    ok: true,
    value: {
      unconfirmedClientMessageIds: ['crashed-send'],
      page: {
        submissions: [
          { clientMessageId: 'crashed-send', dispatchState: 'unknown', recovered: true }
        ]
      }
    }
  })
  expect(prior.dispatch).not.toHaveBeenCalled()
})
