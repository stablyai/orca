import { expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RESTART_CONTINUATION_MESSAGE,
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  restartContinuationMessage
} from '../../../shared/agent-session-restart-continuation'
import { latestNativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import { CALLER, envelope } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER } from './structured-agent-session-restart-resume-wiring'
import {
  interruptedRestart,
  statusNotes
} from './structured-agent-session-restart-interruption-test-harness'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

type Restarted = Awaited<ReturnType<typeof interruptedRestart>>

async function cutTurn(host: StructuredAgentSessionHost): Promise<string> {
  const { items } = await host.journalSnapshot(SESSION)
  const cut = latestNativeChatOrcaStopCut(items, [])
  if (!cut) {
    throw new Error('the restart left no Orca-stop cut')
  }
  return cut.turnItemId
}

function sentTexts(dispatch: Restarted['dispatch']): string[] {
  return dispatch.mock.calls.map(([input]) =>
    input.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  )
}

it('continues with no restart offer, as Orca itself, and the chat says so', async () => {
  const { host, dispatch } = await interruptedRestart()
  await host.restartResume.dismiss()
  expect(await host.restartResume.list()).toEqual([])
  const send = vi.spyOn(host, 'send')

  const answer = await host.restartResume.continueInterrupted(SESSION, await cutTurn(host))

  expect(answer).toMatchObject({
    sessionId: SESSION,
    outcome: expect.stringMatching(/pending|continued/)
  })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  expect(sentTexts(dispatch)).toEqual([AGENT_SESSION_RESTART_CONTINUATION_MESSAGE])
  // Orca-origin continuation must preserve the personal queue pause.
  expect(send.mock.calls[0]?.[0]).toEqual({
    callerKey: STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER
  })
  await vi.waitFor(async () =>
    expect(JSON.stringify(await statusNotes(host))).toContain(
      AGENT_SESSION_RESTART_CONTINUATION_NOTE
    )
  )
})

it('continues a chat that still has its restart offer, in its words, and the offer is spent', async () => {
  const { host, dispatch, marker } = await interruptedRestart()
  expect(await host.restartResume.list()).toHaveLength(1)

  await host.restartResume.continueInterrupted(SESSION, await cutTurn(host))

  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  expect(sentTexts(dispatch)).toEqual([restartContinuationMessage(marker!)])
  expect(await host.restartResume.list()).toEqual([])
})

it('sends once for two clicks at the same moment', async () => {
  const { host, dispatch } = await interruptedRestart()
  const turnItemId = await cutTurn(host)

  const answers = await Promise.all([
    host.restartResume.continueInterrupted(SESSION, turnItemId),
    host.restartResume.continueInterrupted(SESSION, turnItemId)
  ])

  expect(answers.filter((answer) => answer.outcome === 'superseded')).toHaveLength(1)
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
})

it('sends nothing for a retry after an answer that was lost', async () => {
  const { host, dispatch } = await interruptedRestart()
  const turnItemId = await cutTurn(host)
  await host.restartResume.continueInterrupted(SESSION, turnItemId)
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())

  const retry = await host.restartResume.continueInterrupted(SESSION, turnItemId)

  expect(retry).toEqual({ sessionId: SESSION, outcome: 'superseded' })
  expect(dispatch).toHaveBeenCalledOnce()
})

it("sends nothing once the user's own message came first", async () => {
  const { host, dispatch } = await interruptedRestart()
  const turnItemId = await cutTurn(host)
  const body = hostTestMessage('A new request')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })

  const answer = await host.restartResume.continueInterrupted(SESSION, turnItemId)

  expect(answer).toEqual({ sessionId: SESSION, outcome: 'superseded' })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  expect(sentTexts(dispatch)).toEqual(['A new request'])
})

it('sends nothing for a turn that is not the cut the chat sits on', async () => {
  const { host, dispatch } = await interruptedRestart()

  const answer = await host.restartResume.continueInterrupted(SESSION, 'some-other-turn')

  expect(answer).toEqual({ sessionId: SESSION, outcome: 'superseded' })
  expect(dispatch).not.toHaveBeenCalled()
})

it('continues when reading the restart offer hangs', async () => {
  const { host, dispatch } = await interruptedRestart()
  const turnItemId = await cutTurn(host)
  vi.spyOn(host.deps.recoveryCapsule!, 'list').mockReturnValue(new Promise(() => {}))

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const continuation = host.restartResume.continueInterrupted(SESSION, turnItemId)
    await vi.advanceTimersByTimeAsync(2_000)
    await continuation

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    await vi.waitFor(async () =>
      expect(JSON.stringify(await statusNotes(host))).toContain(
        AGENT_SESSION_RESTART_CONTINUATION_NOTE
      )
    )
  } finally {
    try {
      await host.flushAllStreamedEvents()
    } finally {
      vi.useRealTimers()
    }
  }
}, 10_000)

it('answers once Orca accepted it, while the agent is still starting', async () => {
  const { host, acquire, dispatch } = await interruptedRestart()
  const turnItemId = await cutTurn(host)
  const start = acquire.getMockImplementation()
  if (!start) {
    throw new Error('the harness acquire has no implementation')
  }
  let finishStarting!: () => void
  const starting = new Promise<void>((resolve) => {
    finishStarting = resolve
  })
  // Startup outlasts a paired client’s response budget.
  acquire.mockImplementationOnce(async (input) => {
    await starting
    return start(input)
  })

  const answer = await host.restartResume.continueInterrupted(SESSION, turnItemId)

  expect(answer).toEqual({ sessionId: SESSION, outcome: 'pending' })
  expect(dispatch).not.toHaveBeenCalled()
  finishStarting()
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
})

it('says in the chat when the agent cannot start after the click was answered', async () => {
  const { host, acquire } = await interruptedRestart()
  const turnItemId = await cutTurn(host)
  acquire.mockRejectedValueOnce(new Error('the agent could not start'))

  const answer = await host.restartResume.continueInterrupted(SESSION, turnItemId)

  expect(answer).toEqual({ sessionId: SESSION, outcome: 'pending' })
  await vi.waitFor(async () =>
    expect(await statusNotes(host)).toContainEqual({
      text: AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
      tone: 'error'
    })
  )
})

it('continues a reply the user had steered before Orca stopped', async () => {
  const { host, dispatch, store, marker } = await interruptedRestart()
  const turnItemId = await cutTurn(host)
  const fence = store.getRecord(SESSION)?.lease.runtimeFence
  const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (fence === undefined || fence === null || !journal) {
    throw new Error('the restarted chat has no open journal')
  }
  // Client rules still offer Continue after a steer; host admission must agree.
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'steer' },
    hostTestMessage('also update the tests'),
    { fence, turnScope: { kind: 'turn', turnItemId } }
  )

  const answer = await host.restartResume.continueInterrupted(SESSION, turnItemId)

  expect(answer).toEqual({ sessionId: SESSION, outcome: 'pending' })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  expect(sentTexts(dispatch)).toEqual([restartContinuationMessage(marker!)])
})
