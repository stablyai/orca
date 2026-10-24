import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { STOPPED_MESSAGE_INTERRUPTED_MARKER } from '../../../shared/agent-session-stopped-history'
import { AgentJournalSubmissionSchema } from '../../../shared/agent-session-journal-submission-schema'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig

async function start(): Promise<void> {
  rig = await createQueuedMessageTestRig({ restartable: true, starting: true })
}

afterEach(async () => {
  await rig.dispose()
})

function journal(): AgentSessionJournal {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('the conversation is not open')
  }
  return open
}

function text(body: AgentJournalMessageItem): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function carrying(stopped: string[], own: string): string {
  return (
    stopped.map((words) => `${words}\n\n${STOPPED_MESSAGE_INTERRUPTED_MARKER}\n\n`).join('') + own
  )
}

function dispatched(): string[] {
  return rig.dispatch.mock.calls.map(([input]) => text(input.body))
}

async function heldWhileStarting(...texts: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const body of texts) {
    const { id, result } = rig.send(body)
    expect(await result).toMatchObject({ ok: true })
    ids.push(id)
  }
  await eventually(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  )
  return ids
}

async function stopWhileStarting(...texts: string[]): Promise<string[]> {
  const ids = await heldWhileStarting(...texts)
  expect(await rig.stop()).toMatchObject({ ok: true })
  for (const id of ids) {
    expect(await rig.submission(id)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'cancelled', neverReachedAgent: true }
    })
  }
  return ids
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

async function transcript(): Promise<string[]> {
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  expect(page.page.submissions.some((entry) => 'carries' in entry)).toBe(false)
  page.page.submissions.forEach((entry) => AgentJournalSubmissionSchema.parse(entry))
  return projectStructuredAgentSessionMessages(page.page.items, [], page.page.submissions).map(
    (message) =>
      `${message.blocks.map((block) => ('text' in block ? block.text : '')).join('')}${
        message.stoppedBeforeStart ? ' (stopped)' : ''
      }`
  )
}

describe('a Stop withdraws what the agent never got, and the next send delivers it once', () => {
  it('carries them at the front of the next send, in order, and never again', async () => {
    await start()
    const [first, second] = await stopWhileStarting('first', 'second')
    const carrier = await nextSend('what did I send?')
    await rig.settleAccepted(carrier, 'carrier')
    await nextSend('after')

    expect(dispatched()).toEqual([carrying(['first', 'second'], 'what did I send?'), 'after'])
    expect(journal().stoppedHistoryCarried().get(carrier)).toEqual([first, second])
    expect(await transcript()).toEqual([
      'first (stopped)',
      'second (stopped)',
      'Stopped manually',
      'what did I send?',
      'after'
    ])
  })

  it('a carrier refused before any write owes them again; one in doubt never re-sends them', async () => {
    await start()
    await stopWhileStarting('first')
    rig.dispatch.mockResolvedValueOnce({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('writeFailed'), { surface: 'rejection' })
    })
    await nextSend('refused')
    const doubtful = await nextSend('in doubt')
    await rig.host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: doubtful,
      state: 'unknown',
      reason: 'reply lost'
    })
    await nextSend('after')

    expect(dispatched()).toEqual([
      carrying(['first'], 'refused'),
      carrying(['first'], 'in doubt'),
      'after'
    ])
  })
})
