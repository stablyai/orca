import { afterEach, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { domainLifecycleFixture } from './journal-domain-lifecycle.test-fixture'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

it('claims stopped history with the handover and releases it after an unwritten refusal', async () => {
  const f = domainLifecycleFixture(cleanup)
  const body = (text: string) => ({
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }]
  })
  const handover = (clientMessageId: string) =>
    f
      .run({
        kind: 'handover',
        input: {
          clientMessageId,
          fence: 1,
          turnScope: { kind: 'thread' },
          body: body(clientMessageId)
        }
      })
      .then((commit) => commit.value)
  const refuse = (clientMessageId: string) =>
    f.run({
      kind: 'dispatch',
      input: {
        clientMessageId,
        state: 'rejected',
        fence: 1,
        ...agentSessionFailureWords(
          agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
          { surface: 'rejection' }
        )
      }
    })
  for (const clientMessageId of ['owed', 'carrier-a', 'carrier-b']) {
    await f.run({
      kind: 'submission',
      input: {
        clientMessageId,
        payloadFingerprint: clientMessageId,
        body: body(clientMessageId),
        fence: 1,
        handoverRecorded: true,
        origin: 'client',
        source: { kind: 'user' }
      }
    })
  }
  expect(await handover('owed')).toBeNull()
  await refuse('owed')
  expect(await handover('carrier-a')).toEqual({
    messages: [{ clientMessageId: 'owed', words: 'owed' }],
    covers: ['owed']
  })
  expect(await handover('carrier-b')).toBeNull()
  await refuse('carrier-a')
  expect(await handover('carrier-b')).toEqual({
    messages: [
      { clientMessageId: 'owed', words: 'owed' },
      { clientMessageId: 'carrier-a', words: 'carrier-a' }
    ],
    covers: ['owed', 'carrier-a']
  })
})
