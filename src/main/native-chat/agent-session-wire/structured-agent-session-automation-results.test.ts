import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  automationResultNoteBody,
  automationResultNoteClientMessageId,
  makeAutomationResultNote
} from '../../../shared/bots/bot-automation-result-note'
import { projectStructuredAgentSessionMessages } from '../../../shared/agent-session/view/structured-agent-session-message-projection'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './host/testing/structured-agent-session-host-test-data.test-fixture'
import { writeStructuredAgentSessionOrcaNote } from './structured-agent-session-orca-note'

let rig: QueuedMessageTestRig

afterEach(async () => {
  await rig.dispose()
})

function text(body: AgentJournalMessageItem): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function dispatched(): string[] {
  return rig.dispatch.mock.calls.map(([input]) => text(input.body))
}

async function note(runId: string, at: number, result: string): Promise<void> {
  const made = makeAutomationResultNote({
    automationId: 'auto-1',
    automationName: 'Morning digest',
    botName: 'Atlas',
    runId,
    trigger: 'schedule',
    outcome: 'finished',
    result,
    at
  })
  await writeStructuredAgentSessionOrcaNote(
    rig.host,
    SESSION,
    automationResultNoteClientMessageId(runId),
    automationResultNoteBody(made)
  )
}

async function nextSend(body: string): Promise<string> {
  const before = rig.dispatch.mock.calls.length
  const { id, result } = rig.send(body)
  expect(await result).toMatchObject({ ok: true })
  if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase !== 'ready') {
    await rig.proveStart()
  }
  await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(before + 1))
  return id
}

async function transcript() {
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return projectStructuredAgentSessionMessages(page.page.items, [], page.page.submissions)
}

function notesIn(messages: Awaited<ReturnType<typeof transcript>>) {
  return messages.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.type === 'text' && block.automationResult ? [block.automationResult] : []
    )
  )
}

describe('automation result notes ride with the next message, once', () => {
  it('carries unread notes oldest first and only once', async () => {
    rig = await createQueuedMessageTestRig()
    await note('run-2', 2_000, 'second result')
    await note('run-1', 1_000, 'first result')
    const carrier = await nextSend('what happened?')
    await rig.settleAccepted(carrier, 'ok')
    const [first] = dispatched()
    expect(first).toMatch(/^\[Since your last message: 2 automation results/)
    expect(first.indexOf('first result')).toBeLessThan(first.indexOf('second result'))
    expect(first.endsWith(']\n\nwhat happened?')).toBe(true)

    const messages = await transcript()
    expect(notesIn(messages).map((entry) => entry.readWith)).toEqual([carrier, carrier])
    const sent = messages.find((message) => message.id.endsWith(carrier))
    expect(sent?.automationResultsCarried).toBe(2)
    // The person's own row keeps their words; only the agent saw the preamble.
    expect(sent?.blocks).toEqual([{ type: 'text', text: 'what happened?' }])
    await note('run-3', 3_000, 'new result')
    await nextSend('after')
    const second = dispatched()[1]
    expect(second).toContain('new result')
    expect(second).not.toContain('first result')
    expect(second).not.toContain('second result')
    expect(second.endsWith(']\n\nafter')).toBe(true)
  })

  it('a send refused before any write leaves its notes for the next message', async () => {
    rig = await createQueuedMessageTestRig()
    await note('run-1', 1_000, 'the result')
    rig.dispatch.mockResolvedValueOnce({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('writeFailed'), { surface: 'rejection' })
    })
    await nextSend('refused')
    await eventually(async () =>
      expect(await rig.submission(rig.dispatch.mock.calls[0][0].clientMessageId)).toMatchObject({
        dispatchState: 'rejected'
      })
    )
    await nextSend('again')

    expect(dispatched().map((sent) => sent.includes('the result'))).toEqual([true, true])
  })

  it('a send the provider may have read keeps its notes read', async () => {
    rig = await createQueuedMessageTestRig()
    await note('run-1', 1_000, 'the result')
    rig.dispatch.mockResolvedValueOnce({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
        surface: 'rejection'
      })
    })
    await nextSend('refused')
    await eventually(async () =>
      expect(await rig.submission(rig.dispatch.mock.calls[0][0].clientMessageId)).toMatchObject({
        dispatchState: 'rejected'
      })
    )
    await nextSend('again')

    expect(dispatched().map((sent) => sent.includes('the result'))).toEqual([true, false])
  })

  it('notes survive a host restart and still ride once', async () => {
    rig = await createQueuedMessageTestRig()
    await note('run-1', 1_000, 'kept result')
    await rig.restartHostProcess()

    expect(notesIn(await transcript())).toMatchObject([{ runId: 'run-1', result: 'kept result' }])
  })
})
