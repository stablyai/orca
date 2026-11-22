import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../shared/agent-session/view/structured-agent-session-message-projection'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './host/testing/structured-agent-session-host-test-data.test-fixture'
import type { StructuredAgentSessionTurnContext } from './structured-agent-session-turn-context'

let rig: QueuedMessageTestRig

afterEach(async () => {
  await rig.dispose()
})

function text(body: AgentJournalMessageItem): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function turnContext(given: () => void): StructuredAgentSessionTurnContext {
  return {
    plan: async () => ({
      text: '[Standing context changed.]',
      note: { kind: 'status', text: 'Context applied', presentation: 'test-context' },
      given
    })
  }
}

async function send(words: string): Promise<string> {
  const before = rig.dispatch.mock.calls.length
  const { id, result } = rig.send(words)
  expect(await result).toMatchObject({ ok: true })
  if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase !== 'ready') {
    await rig.proveStart()
  }
  await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(before + 1))
  return id
}

async function rows(): Promise<string[]> {
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return projectStructuredAgentSessionMessages(page.page.items, [], page.page.submissions).map(
    (message) => message.blocks.map((block) => ('text' in block ? block.text : '')).join('')
  )
}

describe("the host's turn context", () => {
  it('rides ahead of the words, is given once the agent takes the turn, and leaves its row', async () => {
    const given = vi.fn()
    rig = await createQueuedMessageTestRig({ hostDeps: { turnContext: turnContext(given) } })
    const id = await send('hello')
    await rig.settleAccepted(id, 'ok')

    expect(text(rig.dispatch.mock.calls[0]![0].body)).toBe('[Standing context changed.]\n\nhello')
    await eventually(() => expect(given).toHaveBeenCalledTimes(1))
    expect(await rows()).toContain('Context applied')
  })

  it('a refused turn gives nothing and leaves no row', async () => {
    const given = vi.fn()
    rig = await createQueuedMessageTestRig({ hostDeps: { turnContext: turnContext(given) } })
    rig.dispatch.mockResolvedValueOnce({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('writeFailed'), { surface: 'rejection' })
    })
    const id = await send('refused')
    await eventually(async () =>
      expect(await rig.submission(id)).toMatchObject({ dispatchState: 'rejected' })
    )

    expect(given).not.toHaveBeenCalled()
    expect(await rows()).not.toContain('Context applied')
  })
})

describe("a launch's update to the agent", () => {
  it("rides a worker's report, which the person-only plan skips, once", async () => {
    let pending = true
    const plan = vi.fn(async () => null)
    rig = await createQueuedMessageTestRig({
      hostDeps: {
        turnContext: {
          plan,
          launchUpdate: async () =>
            pending ? { text: '[Linked skills now: none.]', given: () => (pending = false) } : null
        }
      }
    })
    const worker = { from: { kind: 'agent' as const, senders: [], orchestration: null } }
    const first = rig.send('Worker finished.', undefined, worker)
    expect(await first.result).toMatchObject({ ok: true })
    if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase !== 'ready') {
      await rig.proveStart()
    }
    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(1))
    await rig.settleAccepted(first.id, 'ok')

    expect(text(rig.dispatch.mock.calls[0]![0].body)).toBe(
      '[Linked skills now: none.]\nWorker finished.'
    )
    await eventually(() => expect(pending).toBe(false))
    expect(plan).not.toHaveBeenCalled()

    const second = rig.send('Worker finished again.', undefined, worker)
    expect(await second.result).toMatchObject({ ok: true })
    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(2))
    expect(text(rig.dispatch.mock.calls[1]![0].body)).toBe('Worker finished again.')
  })
  it('never goes ahead of a slash command, which must open the prompt; it waits for the next turn', async () => {
    let pending = true
    rig = await createQueuedMessageTestRig({
      hostDeps: {
        turnContext: {
          plan: async () => null,
          launchUpdate: async () =>
            pending ? { text: '[Linked skills now: none.]', given: () => (pending = false) } : null
        }
      }
    })
    const command = rig.send('/context')
    expect(await command.result).toMatchObject({ ok: true })
    if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase !== 'ready') {
      await rig.proveStart()
    }
    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(1))
    await rig.settleAccepted(command.id, 'ok')
    expect(text(rig.dispatch.mock.calls[0]![0].body)).toBe('/context')
    expect(pending).toBe(true)

    const worker = rig.send('Worker finished.', undefined, {
      from: { kind: 'agent', senders: [], orchestration: null }
    })
    expect(await worker.result).toMatchObject({ ok: true })
    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(2))
    expect(text(rig.dispatch.mock.calls[1]![0].body)).toBe(
      '[Linked skills now: none.]\nWorker finished.'
    )
  })
})

describe('what a message alone needs said', () => {
  it('rides ahead of only the message that asks for it; the chat shows the words alone', async () => {
    const context = "<orca_context>Perf bot is the user's Orca bot.</orca_context>"
    rig = await createQueuedMessageTestRig({
      hostDeps: {
        turnContext: {
          plan: async () => null,
          mentions: async (_sessionId, message) =>
            text(message).includes('[Bot: ') ? context : null
        }
      }
    })
    const first = await send('Ask [Bot: Perf bot](bot:perf) about startup')
    await rig.settleAccepted(first, 'ok')
    await send('thanks')

    expect(text(rig.dispatch.mock.calls[0]![0].body)).toBe(
      `${context}\n\nAsk [Bot: Perf bot](bot:perf) about startup`
    )
    expect(text(rig.dispatch.mock.calls[1]![0].body)).toBe('thanks')
    expect(await rows()).toEqual(['Ask [Bot: Perf bot](bot:perf) about startup', 'thanks'])
  })
})
