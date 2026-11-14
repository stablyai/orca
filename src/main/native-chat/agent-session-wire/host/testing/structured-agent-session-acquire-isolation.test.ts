import { expect, it, vi } from 'vitest'
import { agentSessionRefusalError } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { readTestHostJournal } from '../../../agent-session-journal/journal-observation.test-support'
import {
  openTestAgentSessionRecordStore,
  openTestAgentSessionDatabase
} from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data.test-fixture'
import { journalIdentityFor } from '../../acquisition/structured-agent-session-attach'
import { openAgentSessionJournal } from '../../../agent-session-journal/journal-store-factory'
import { digestPayload } from '../../../agent-session-journal/item-lifecycle/journal-payload-bounds'
import {
  CALLER,
  attach,
  attachParams,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host.test-fixture'

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
    database: await openTestAgentSessionDatabase(prior.root)
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

it('rejects reopened-chat sends while its conversation runs in a terminal and resumes after it exits', async () => {
  await attach()
  const { host, dispatch } = hostTestState()
  await host.close(HOST_TEST_SESSION, 'evict')
  let terminalWriting = true
  host.deps.assertNoTerminalWriter = async () => {
    if (terminalWriting) {
      throw agentSessionRefusalError('agent_session_conflict', {
        reason: 'conversationHeldElsewhere'
      })
    }
  }
  await host.revealSession(HOST_TEST_SESSION)
  const send = async (text: string) => {
    const body = hostTestMessage(text)
    const request = envelope('agentSession.send', { body })
    expect(await host.send(CALLER, { envelope: request, body })).toMatchObject({ ok: true })
    return request.clientOperationId
  }
  const submission = async (clientMessageId: string) =>
    (await readTestHostJournal(host, HOST_TEST_SESSION)).submissions.find(
      (entry) => entry.clientMessageId === clientMessageId
    )

  for (const text of ['first', 'second']) {
    const id = await send(text)
    await vi.waitFor(
      async () =>
        expect(await submission(id)).toMatchObject({
          dispatchState: 'rejected',
          rejection: { kind: 'conversationOpenInTerminal' }
        }),
      { timeout: 10_000 }
    )
  }
  expect(dispatch).not.toHaveBeenCalled()

  terminalWriting = false
  const id = await send('after the terminal exits')
  await vi.waitFor(
    async () => expect(await submission(id)).toMatchObject({ dispatchState: 'accepted' }),
    { timeout: 10_000 }
  )
})
