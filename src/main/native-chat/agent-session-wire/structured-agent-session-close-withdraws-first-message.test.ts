// A launch prompt's caller reads the chat's first message to its final state. Closing the chat
// while that message waits out a retried start must end the read: the host withdraws the message
// and publishes that rejection, so the reader is never left waiting on a chat that is gone.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionPreSpawnError } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

let root: string
let host: StructuredAgentSessionHost

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-close-withdraws-first-message-'))
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store: await openTestAgentSessionRecordStore(root),
    adapter: {
      supportsCreate: () => true,
      // A start refused before it ran, by a situation that clears on its own: retried later.
      acquire: vi.fn(async () => {
        throw new AgentSessionPreSpawnError(new Error('switching'), {
          reason: 'accountSwitchInProgress'
        })
      }),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    now: () => NOW
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

it('rejects the waiting first message, and its reader sees the rejection', async () => {
  const created = await host.create({ callerKey: 'client-1' }, hostTestAttachParams(null))
  if (!created.ok) {
    throw new Error('create refused')
  }
  const body = hostTestMessage('fix the checks')
  const clientMessageId = hostTestOperationId()
  await host.send(
    { callerKey: 'client-1' },
    {
      envelope: {
        sessionId: SESSION,
        clientOperationId: clientMessageId,
        expectedRuntimeFence: created.fence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      },
      body
    }
  )
  await vi.waitFor(async () =>
    expect(
      (await host.journalSnapshot(SESSION)).submissions[0]?.startRetry?.nextAttemptAt
    ).toBeDefined()
  )
  const events: AgentSessionSubscribeEvent[] = []
  await host.subscribe({ id: 'launch-prompt', sessionId: SESSION, emit: (e) => events.push(e) })

  await host.close(SESSION, 'user-close')

  const seen = events.flatMap((event) =>
    event.type === 'batch'
      ? event.batch.submissions
      : event.type === 'snapshot' || event.type === 'reset'
        ? event.page.submissions
        : []
  )
  const ended = events.some((event) => event.type === 'end')
  // Withdrawn with the start failure it was waiting out, so it reads as that failure.
  const rejected = seen.some(
    (entry) =>
      entry.clientMessageId === clientMessageId &&
      entry.dispatchState === 'rejected' &&
      entry.rejection?.kind === 'accountSwitchInProgress'
  )
  expect(ended || rejected).toBe(true)
  expect(
    (await host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === clientMessageId
    )
  ).toMatchObject({ dispatchState: 'rejected' })
})
