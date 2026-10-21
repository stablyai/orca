import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { beforeEach, describe, expect, it, type Mock } from 'vitest'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState,
  seedApproval
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_THREAD as THREAD } from './structured-agent-session-host-test-data'

let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>

beforeEach(() => {
  ;({ host, acquire, cancelTurn } = hostTestState())
})

describe('a prompt Cancel pressed again', () => {
  it('answers a second Cancel of a prompt quietly, sent before or after the first settles', async () => {
    await attach()
    const prompt = await seedApproval()
    const identity = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 99 }
    const first = Promise.withResolvers<undefined>()
    cancelTurn.mockImplementationOnce(async () => {
      await first.promise
      // As a provider does: interrupting the turn cancels the prompt it was waiting on.
      acquire.mock.calls.at(-1)?.[0].events?.appendItem(
        identity,
        {
          kind: 'approval',
          title: 'Run the command?',
          detail: null,
          options: [{ id: 'allow', label: 'Allow' }],
          resolution: {
            state: 'cancelled',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      return { cancelled: true }
    })
    const fields = {
      turnId: 'turn-1',
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    const cancel = () =>
      host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })

    const pressed = cancel()
    const whileInFlight = cancel()
    first.resolve(undefined)
    const after = cancel()

    expect(await pressed).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(await whileInFlight).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(await after).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(cancelTurn).toHaveBeenCalledOnce()
  })
})
