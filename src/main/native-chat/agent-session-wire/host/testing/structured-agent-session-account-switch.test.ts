import { afterEach, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../../../shared/agent-status/child-work/agent-status-child-work-view'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { appendUsageLimitedTurn } from './structured-agent-session-usage-limited-turn.test-fixture'
import { childRecord } from '../../recovery/testing/structured-agent-session-restart-resume.test-fixture'
import { releaseIdleChatsOnOtherAccount } from '../structured-agent-session-account-switch'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

const home = (path: string) => ({ variable: 'CLAUDE_CONFIG_DIR', path })
const settledTask = () =>
  childRecord({ id: 'task-a', kind: 'command', state: 'done', settledAt: NOW + 60_000 })

/** A Claude chat (a bot's Chat, as the host sees it) with one finished turn on account A. Its agent
 *  launches under whichever folder is selected when it starts; the selection lookup captures the
 *  folder first and may then be held, as the real one waits on file reads. */
async function idleClaudeChat() {
  await rig?.dispose()
  let selected = '/homes/a'
  let held: { gate: Promise<void>; reached: () => void } | null = null
  let childWork: AgentChildWorkView[] = []
  const current = await createQueuedMessageTestRig({
    agent: 'claude',
    restartable: true,
    acquiredAccountHome: () => home(selected),
    hostDeps: {
      statusSink: { publish: () => {}, forget: () => {}, readChildWork: () => childWork }
    }
  })
  rig = current
  current.host.deps.launchAccountHome = async () => {
    const captured = home(selected)
    if (held) {
      held.reached()
      await held.gate
    }
    return captured
  }
  await current.settleAccepted(await current.workingSend(), 'one')
  // Idle: the first send's delivery has finished, so a switch does not leave the agent to it.
  await eventually(() =>
    expect(current.host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(
      false
    )
  )
  const journal = () => current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  return {
    rig: current,
    child: () => current.host.collaboratorsForTests().sessions.get(SESSION)?.child,
    conversation: () => current.store.getRecord(SESSION)?.providerHandleChain.at(-1)?.handle,
    select: (path: string) => {
      selected = path
    },
    /** What the switch's listener does for this host's chats, told of a selection still committed
     *  while `committed` says so. */
    moveChats: (committed: () => boolean = () => true) =>
      releaseIdleChatsOnOtherAccount(current.host, 'claude', committed),
    /** Holds the selection lookup once it captured its folder; `parked` settles when it has. */
    holdLookup: () => {
      const gate = Promise.withResolvers<void>()
      const parked = Promise.withResolvers<void>()
      held = { gate: gate.promise, reached: parked.resolve }
      return {
        parked: parked.promise,
        release: () => {
          held = null
          gate.resolve()
        }
      }
    },
    childWork: (next: AgentChildWorkView[]) => {
      childWork = next
    },
    /** The agent's last turn ended on its account's usage limit. */
    hitUsageLimit: () =>
      appendUsageLimitedTurn(journal(), {
        fence: 1,
        resetsAt: NOW + 60_001,
        name: 'spent',
        at: NOW + 1
      }),
    journal,
    openTurn: async () => {
      current
        .providerEvents()
        .appendItem(
          { provider: 'claude', sessionId: THREAD, uuid: 'working' },
          { kind: 'turn', turnId: 'working', state: 'running' },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      await current.host.flushStreamedEvents(SESSION)
    },
    /** A send after the stop, on the fence it left, as a chat view or a bot's dispatch reads it. */
    sendAfterStop: async () => {
      const fence = current.store.getConversation(SESSION)!.currentFence
      const { id, result } = current.send('and then?', undefined, { fence })
      expect(await result).toMatchObject({ ok: true })
      await eventually(async () =>
        expect((await current.submission(id))?.handedOverAt).toBeDefined()
      )
    }
  }
}

it('stops an idle chat agent on the outgoing account at the switch, then resumes its conversation on the new one', async () => {
  const chat = await idleClaudeChat()
  const conversation = chat.conversation()
  expect(chat.child()?.accountHome).toEqual(home('/homes/a'))

  chat.select('/homes/b')
  await chat.moveChats()
  // Before any send: the process that held the old account is gone.
  expect(chat.child()).toBeNull()

  const starts = chat.rig.starts.mock.calls.length
  await chat.sendAfterStop()
  expect(chat.rig.starts.mock.calls.length).toBe(starts + 1)
  expect(chat.child()?.accountHome).toEqual(home('/homes/b'))
  expect(chat.conversation()).toEqual(conversation)
})

it('lets a running turn finish on its account', async () => {
  const chat = await idleClaudeChat()
  await chat.rig.workingSend()
  await chat.openTurn()
  const running = chat.child()
  chat.select('/homes/b')
  await chat.moveChats()
  expect(chat.child()).toBe(running)
  expect(chat.rig.closeSession).not.toHaveBeenCalled()
})

it('keeps an agent that owes its lead a wake-up when its last turn ended normally', async () => {
  const chat = await idleClaudeChat()
  const waiting = chat.child()
  chat.childWork([settledTask()])
  chat.select('/homes/b')
  await chat.moveChats()
  expect(chat.child()).toBe(waiting)
  expect(chat.rig.closeSession).not.toHaveBeenCalled()
})

it('keeps an agent that owes a wake-up even when a usage limit ended its last turn', async () => {
  const chat = await idleClaudeChat()
  const waiting = chat.child()
  chat.childWork([settledTask()])
  // A resumed agent is not reliably handed a finished task's result, so the wake-up keeps it.
  await chat.hitUsageLimit()
  chat.select('/homes/b')
  await chat.moveChats()
  expect(chat.child()).toBe(waiting)
  expect(chat.rig.closeSession).not.toHaveBeenCalled()
})

it('keeps the agent when the selection changes again while its lookup waits', async () => {
  const chat = await idleClaudeChat()
  const idle = chat.child()
  let revision = 1
  chat.select('/homes/b')
  const lookup = chat.holdLookup()
  const told = revision
  const moving = chat.moveChats(() => revision === told)
  await lookup.parked
  // The lookup already captured B; B-to-A commits before it answers.
  chat.select('/homes/a')
  revision += 1
  lookup.release()
  await moving
  expect(chat.child()).toBe(idle)
  expect(chat.rig.closeSession).not.toHaveBeenCalled()
})

it('keeps the agent when the lookup read a selection that was still pending and then rolled back', async () => {
  const chat = await idleClaudeChat()
  const idle = chat.child()
  let pending = false
  // An earlier switch's run reads while a later select to B is saved but not yet in effect.
  pending = true
  chat.select('/homes/b')
  const lookup = chat.holdLookup()
  const moving = chat.moveChats(() => !pending)
  await lookup.parked
  // That select fails and restores A; its own recheck run follows.
  chat.select('/homes/a')
  lookup.release()
  await moving
  pending = false
  expect(chat.child()).toBe(idle)
  await chat.moveChats()
  expect(chat.child()).toBe(idle)
  expect(chat.rig.closeSession).not.toHaveBeenCalled()
})

it('keeps the agent when its provider opens a turn while the lookup waits', async () => {
  const chat = await idleClaudeChat()
  const idle = chat.child()
  chat.select('/homes/b')
  const lookup = chat.holdLookup()
  const moving = chat.moveChats()
  await lookup.parked
  // A task notification wakes the lead before the lookup answers.
  await chat.openTurn()
  lookup.release()
  await moving
  expect(chat.child()).toBe(idle)
  expect(chat.rig.closeSession).not.toHaveBeenCalled()
})

it('keeps an agent a send already replaced on the new account', async () => {
  const chat = await idleClaudeChat()
  chat.select('/homes/b')
  await chat.rig.settleAccepted(await chat.rig.workingSend(), 'two')
  const replaced = chat.child()
  expect(replaced?.accountHome).toEqual(home('/homes/b'))
  const closes = chat.rig.closeSession.mock.calls.length
  await chat.moveChats()
  expect(chat.child()).toBe(replaced)
  expect(chat.rig.closeSession.mock.calls.length).toBe(closes)
})

it("keeps the agent when its provider's new turn has not reached the journal yet", async () => {
  const chat = await idleClaudeChat()
  const idle = chat.child()
  const journal = chat.journal()
  // The provider opens a turn on its own; its write into the journal is held before it commits.
  const write = Promise.withResolvers<void>()
  const appendSteps = journal.appendSteps.bind(journal)
  journal.appendSteps = async (...steps) => {
    await write.promise
    return appendSteps(...steps)
  }
  chat.rig
    .providerEvents()
    .appendItem(
      { provider: 'claude', sessionId: THREAD, uuid: 'autonomous' },
      { kind: 'turn', turnId: 'autonomous', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  try {
    chat.select('/homes/b')
    let settled = false
    const moved = chat.moveChats().then(() => {
      settled = true
    })
    // A stop here could wait on the held write: look once the check ended or marked the agent.
    await vi.waitFor(() => expect(settled || chat.child()?.close !== undefined).toBe(true))
    void moved
    expect(chat.child()).toBe(idle)
    expect(chat.child()?.close).toBeUndefined()
    expect(chat.rig.closeSession).not.toHaveBeenCalled()
  } finally {
    write.resolve()
  }
  await chat.rig.host.flushStreamedEvents(SESSION)
})

it('keeps the agent when the journal moves under its work read, without holding up a send', async () => {
  const chat = await idleClaudeChat()
  const idle = chat.child()
  const journal = chat.journal()
  // Every early child-work read sees the journal move under it, as provider output streaming in does.
  let moving = 20
  const work = journal.reads.work
  journal.reads.work = async (request) => {
    const answer = await work(request)
    if (request.operation.kind === 'child-work' && moving > 0) {
      moving -= 1
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `streamed-${moving}` },
        {
          kind: 'status',
          ...agentSessionFailureWords(agentSessionFailureFact('providerRetrying'), {
            surface: 'row'
          })
        },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    return answer
  }
  chat.select('/homes/b')
  await chat.moveChats()
  // Uncertain evidence keeps the agent; the check does not wait for the journal to settle.
  expect(chat.child()).toBe(idle)
  expect(chat.rig.closeSession).not.toHaveBeenCalled()
  const { result } = chat.rig.send('meanwhile')
  expect(await result).toMatchObject({ ok: true })
})

it('asks only whether a send is queued, without reading the recoverable sends', async () => {
  const chat = await idleClaudeChat()
  const journal = chat.journal()
  const input = vi.spyOn(journal.reads, 'input')
  // A selection that changes nothing for this chat: the check runs and stops nothing, so every
  // read seen here is its own.
  const idle = chat.child()
  await chat.moveChats()
  const asked = input.mock.calls.map(([operation]) => operation.kind)
  expect(asked).toContain('first-queued')
  expect(asked).not.toContain('recoverable-submissions')
  expect(chat.child()).toBe(idle)
})

it('keeps the agent when a background task settles after its check, before it is marked closing', async () => {
  const chat = await idleClaudeChat()
  const idle = chat.child()
  // The task's result reaches the chat's child-work status (no journal row) as the stop begins.
  const requireWritableRecord = chat.rig.store.requireWritableRecord.bind(chat.rig.store)
  vi.spyOn(chat.rig.store, 'requireWritableRecord').mockImplementation((sessionId) => {
    chat.childWork([settledTask()])
    return requireWritableRecord(sessionId)
  })
  chat.select('/homes/b')
  await chat.moveChats()
  expect(chat.child()).toBe(idle)
  expect(chat.child()?.close).toBeUndefined()
  expect(chat.rig.closeSession).not.toHaveBeenCalled()
})
