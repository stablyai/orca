import { describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session/view/agent-session-turn-completion-wire'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import { postConnectorBotMessage } from '../connector-cloud/connector-replies'
import { makeTestBot } from './bot.test-fixture'
import { BOT_QUIET_MARKER } from '../../shared/bot-quiet-result'
import {
  deliverBotRunResult,
  type BotRunDeliveryDependencies,
  type BotRunResult
} from './bot-run-results'
import { watchBotTurnEnds } from './bot-run-turn-watch'

const SESSION = 'session-1'

function deps(overrides: Partial<BotRunDeliveryDependencies> = {}) {
  return {
    sendToChat: vi.fn<BotRunDeliveryDependencies['sendToChat']>(async () => undefined),
    noteToChat: vi.fn<BotRunDeliveryDependencies['noteToChat']>(async () => undefined),
    postAsBot: vi.fn<BotRunDeliveryDependencies['postAsBot']>(async () => ({
      ok: true as const,
      value: undefined
    })),
    notify: vi.fn<BotRunDeliveryDependencies['notify']>(),
    cloudSignedOut: () => false,
    noteToRun: vi.fn<BotRunDeliveryDependencies['noteToRun']>(async () => undefined),
    replyInThread: vi.fn<BotRunDeliveryDependencies['replyInThread']>(async () => ({
      ok: true as const,
      value: {}
    })),
    turnForOf: vi.fn<BotRunDeliveryDependencies['turnForOf']>(async () => 'owner' as const),
    ...overrides
  }
}

function result(overrides: Partial<BotRunResult> = {}): BotRunResult {
  return {
    automation: { id: 'auto-1', name: 'Morning digest', dtstart: 1 },
    run: { id: 'run-1', trigger: 'scheduled' },
    bot: makeTestBot(),
    target: { runsIn: 'new', resultsTo: 'chat' },
    sessionId: SESSION,
    ended: { outcome: 'success', message: 'Two PRs merged overnight.' },
    ...overrides
  }
}

describe('deliverBotRunResult', () => {
  it("posts the result to the event's thread and leaves its delivery notice on the run", async () => {
    const notice = "Scout won't take this as a request."
    const delivery = deps({
      replyInThread: vi.fn<BotRunDeliveryDependencies['replyInThread']>(async () => ({
        ok: true as const,
        value: { notices: [notice] }
      }))
    })
    const thread = { source: 'slack' as const, externalId: 'trigger:abc' }

    const completion = await deliverBotRunResult(
      delivery,
      result({ target: { runsIn: 'chat', resultsTo: 'thread', threadPost: thread } })
    )

    expect(completion).toMatchObject({ status: 'completed' })
    expect(delivery.replyInThread).toHaveBeenCalledWith(
      thread,
      'run-result:run-1',
      'Two PRs merged overnight.',
      'owner'
    )
    expect(delivery.noteToRun).toHaveBeenCalledWith(SESSION, 'result-notices:run-1', notice)
  })

  it("leaves a new conversation's result in the bot's Chat as a note, starting no turn", async () => {
    const delivery = deps()

    const completion = await deliverBotRunResult(delivery, result())

    expect(completion).toMatchObject({ status: 'completed' })
    expect(delivery.noteToChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bot-1' }),
      expect.objectContaining({
        automationId: 'auto-1',
        automationName: 'Morning digest',
        runId: 'run-1',
        sessionId: SESSION,
        trigger: 'schedule',
        outcome: 'finished',
        result: 'Two PRs merged overnight.'
      })
    )
    expect(delivery.sendToChat).not.toHaveBeenCalled()
  })

  it("leaves a failure note and saves the provider's error on the run", async () => {
    const delivery = deps()

    const completion = await deliverBotRunResult(
      delivery,
      result({
        automation: { id: 'auto-2', name: 'Hook echo', dtstart: Number.MAX_SAFE_INTEGER },
        ended: { outcome: 'failure', message: '', error: 'API Error: 503 Service unavailable' }
      })
    )

    expect(completion).toEqual({
      status: 'dispatch_failed',
      error: 'API Error: 503 Service unavailable'
    })
    expect(delivery.noteToChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        trigger: 'event',
        outcome: 'couldNotFinish',
        result: "The bot's turn ended without finishing (failure)."
      })
    )
    expect(delivery.sendToChat).not.toHaveBeenCalled()
  })

  it('says on the run when the note could not be added', async () => {
    const completion = await deliverBotRunResult(
      deps({
        noteToChat: async () => {
          throw new Error('journal_read_only')
        }
      }),
      result()
    )

    expect(completion).toMatchObject({
      status: 'completed',
      error: "The result couldn't be added to the bot's Chat."
    })
  })

  it("sends the result to the bot's Chat as a message from the run when the bot is to react", async () => {
    const delivery = deps()

    const completion = await deliverBotRunResult(
      delivery,
      result({ target: { runsIn: 'new', resultsTo: 'chat', letBotReact: true } })
    )

    expect(completion).toMatchObject({
      status: 'completed',
      outputSnapshot: { content: 'Two PRs merged overnight.' }
    })
    expect(delivery.sendToChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bot-1' }),
      'Result of "Morning digest":\n\nTwo PRs merged overnight.',
      expect.objectContaining({ kind: 'agent' })
    )
    expect(delivery.postAsBot).not.toHaveBeenCalled()
    expect(delivery.noteToChat).not.toHaveBeenCalled()
  })

  it('says so when an event run meant for its thread got none, and posts nothing', async () => {
    const delivery = deps()
    const threaded = { botId: 'bot-1', runsIn: 'new' as const, resultsTo: 'thread' as const }
    const missed = await deliverBotRunResult(
      delivery,
      result({
        automation: { id: 'auto-1', name: 'Morning digest', dtstart: 1, bot: threaded },
        run: { id: 'run-1', trigger: 'event' },
        target: { runsIn: 'new', resultsTo: 'none' }
      })
    )
    expect(missed.error).toBe(
      "Orca Cloud didn't link this event to a thread, so the result stayed in this run's conversation."
    )
    const manual = await deliverBotRunResult(
      delivery,
      result({
        automation: { id: 'auto-1', name: 'Morning digest', dtstart: 1, bot: threaded },
        run: { id: 'run-2', trigger: 'manual' },
        target: { runsIn: 'new', resultsTo: 'none' }
      })
    )
    expect(manual.error).toBeUndefined()
    expect(delivery.postAsBot).not.toHaveBeenCalled()
    expect(delivery.sendToChat).not.toHaveBeenCalled()
    expect(delivery.noteToChat).not.toHaveBeenCalled()
  })

  it("leaves a run answered in its event's thread there, with no note in the Chat", async () => {
    const delivery = deps()
    const threaded = { botId: 'bot-1', runsIn: 'new' as const, resultsTo: 'thread' as const }
    const completion = await deliverBotRunResult(
      delivery,
      result({
        automation: { id: 'auto-1', name: 'Morning digest', dtstart: 1, bot: threaded },
        run: { id: 'run-1', trigger: 'event' },
        target: { runsIn: 'new', resultsTo: 'thread' }
      })
    )
    expect(completion).toMatchObject({ status: 'completed' })
    expect(completion.error).toBeUndefined()
    expect(delivery.noteToChat).not.toHaveBeenCalled()
    expect(delivery.sendToChat).not.toHaveBeenCalled()
    expect(delivery.postAsBot).not.toHaveBeenCalled()
  })

  it("leaves a Chat run's result where it already is", async () => {
    const delivery = deps()

    await deliverBotRunResult(delivery, result({ target: { runsIn: 'chat', resultsTo: 'chat' } }))

    expect(delivery.sendToChat).not.toHaveBeenCalled()
    expect(delivery.noteToChat).not.toHaveBeenCalled()
  })

  it('posts the channel result and leaves its delivery notice on the run', async () => {
    const notice = "Scout won't take this as a request."
    const delivery = deps({
      postAsBot: vi.fn<BotRunDeliveryDependencies['postAsBot']>(async () => ({
        ok: true as const,
        value: { notices: [notice] }
      }))
    })
    const completion = await deliverBotRunResult(
      delivery,
      result({ target: { runsIn: 'new', resultsTo: { channel: 'C123' } } })
    )
    expect(completion.error).toBeUndefined()
    expect(delivery.postAsBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
      postId: 'run-1',
      channelId: 'C123',
      text: 'Two PRs merged overnight.',
      turnFor: 'owner'
    })
    expect(delivery.noteToRun).toHaveBeenCalledWith(SESSION, 'result-notices:run-1', notice)
  })

  it('says in the run, signed out, that its result was not posted to Slack', async () => {
    const delivery = deps({ cloudSignedOut: () => true })

    const completion = await deliverBotRunResult(
      delivery,
      result({ target: { runsIn: 'new', resultsTo: { channel: 'C123' } } })
    )

    expect(delivery.postAsBot).not.toHaveBeenCalled()
    expect(completion.error).toBe(
      "Not posted to Slack: this computer isn't signed in to Orca Cloud."
    )
    expect(delivery.noteToRun).toHaveBeenCalledWith(
      SESSION,
      'result-not-posted:run-1',
      "Not posted to Slack: this computer isn't signed in to Orca Cloud."
    )
  })

  it('says on a headless server how its owner signs it in, so the result can post next time', async () => {
    const delivery = deps({ cloudSignedOut: () => true, signInServer: () => 'box1' })

    const completion = await deliverBotRunResult(
      delivery,
      result({ target: { runsIn: 'new', resultsTo: { channel: 'C123' } } })
    )

    expect(completion.error).toMatch(
      /^Not posted to Slack\. This Orca server \(box1\) isn't signed in to Orca Cloud\. Run `orca auth login` in a terminal on box1 .+Connectors tab in Orca on your computer\.$/
    )
  })

  it('posts to a place named by ref through the actions route, once per run', async () => {
    const postAsBot = vi.fn<BotRunDeliveryDependencies['postAsBot']>(async () => ({
      ok: true as const,
      value: undefined
    }))
    const delivery = deps({ postAsBot })
    for (const resultsTo of [
      { channel: 'C123', ref: 'slack:T1:C123', label: '#eng' },
      { linearIssue: 'ENG-7', ref: 'linear:org-1:issue-7', label: 'ENG-7 Flaky login' }
    ]) {
      await deliverBotRunResult(delivery, result({ target: { runsIn: 'new', resultsTo } }))
    }
    expect(postAsBot.mock.calls.map(([, body]) => body)).toEqual([
      {
        postId: 'run-1',
        ref: 'slack:T1:C123',
        text: 'Two PRs merged overnight.',
        turnFor: 'owner'
      },
      { postId: 'run-1', ref: 'linear:org-1:issue-7', text: 'Two PRs merged overnight.' }
    ])
  })

  it('comments on the Linear issue once per run', async () => {
    const delivery = deps()

    const completion = await deliverBotRunResult(
      delivery,
      result({ target: { runsIn: 'new', resultsTo: { linearIssue: 'ENG-123' } } })
    )

    expect(completion.error).toBeUndefined()
    expect(delivery.postAsBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
      postId: 'run-1',
      issue: 'ENG-123',
      text: 'Two PRs merged overnight.'
    })
  })

  it('posts nothing when the cloud is off, and says so on the run', async () => {
    const completion = await deliverBotRunResult(
      deps({ postAsBot: () => null }),
      result({ target: { runsIn: 'new', resultsTo: { channel: 'C123' } } })
    )

    expect(completion).toMatchObject({
      status: 'completed',
      error: "Orca Cloud isn't connected, so the result wasn't posted."
    })
  })

  it('delivers nothing for a quiet result or for Nowhere', async () => {
    for (const run of [
      result({ ended: { outcome: 'success', message: `Nothing new.\n${BOT_QUIET_MARKER}\n` } }),
      result({ target: { runsIn: 'new', resultsTo: 'none' } })
    ]) {
      const delivery = deps()
      expect(await deliverBotRunResult(delivery, run)).toMatchObject({ status: 'completed' })
      expect(delivery.sendToChat).not.toHaveBeenCalled()
      expect(delivery.noteToChat).not.toHaveBeenCalled()
      expect(delivery.postAsBot).not.toHaveBeenCalled()
    }
  })

  it('posts nothing anywhere when its own reply is unavailable, and says why', async () => {
    for (const resultsTo of ['chat', { channel: 'C123' }, { linearIssue: 'ENG-123' }] as const) {
      const delivery = deps()

      const completion = await deliverBotRunResult(
        delivery,
        result({ target: { runsIn: 'new', resultsTo }, ended: { unavailable: 'removed' } })
      )

      expect(completion).toEqual({
        status: 'dispatch_failed',
        error:
          "This run's message was removed from the Chat before it was sent, so no result was sent."
      })
      expect(delivery.sendToChat).not.toHaveBeenCalled()
      expect(delivery.postAsBot).not.toHaveBeenCalled()
      expect(delivery.notify).not.toHaveBeenCalled()
    }
  })

  it("tells the owner when a run couldn't finish, if they asked to be told", async () => {
    const delivery = deps()

    const completion = await deliverBotRunResult(
      delivery,
      result({ ended: { outcome: 'failure', message: 'partial' } })
    )

    expect(completion.status).toBe('dispatch_failed')
    // Banner only: the failed turn already pushed to the phone.
    expect(delivery.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'bot-could-not-finish:bot-1:Morning digest',
        title: "Reviewer couldn't finish",
        body: '"Morning digest" ended before it finished.',
        phone: false
      })
    )
    expect(delivery.sendToChat).not.toHaveBeenCalled()

    const quiet = deps()
    await deliverBotRunResult(
      quiet,
      result({
        bot: makeTestBot({
          notifications: { needsPermission: true, taskComplete: true, couldNotFinish: false }
        }),
        ended: { outcome: 'cancellation', message: '' }
      })
    )
    expect(quiet.notify).not.toHaveBeenCalled()
  })
})

describe('watchBotTurnEnds', () => {
  const SEND = { sessionId: SESSION, clientMessageId: 'message-1', fingerprint: '' }
  const TURN_ITEM = 'turn-item-1'
  const opener = agentJournalSubmissionKey(SEND.clientMessageId)
  const row = { revision: 1, observedAt: 1 }

  /** The run's journal: its message, the turn it opened, and that turn's answer. Mutable. */
  function feed() {
    let emit: (event: AgentSessionTurnCompletionEvent) => void = () => {}
    const dispose = vi.fn()
    const state: {
      turn: Record<string, unknown>
      question: 'pending' | 'answered' | null
      submission: Record<string, unknown>
      /** Whether the agent that asked is still running. */
      live: boolean
    } = {
      turn: { state: 'completed', outcome: 'success' },
      question: null,
      submission: { dispatchState: 'accepted', reason: null },
      live: true
    }
    const host = {
      subscribeTurnCompletions: vi.fn(
        (subscriber: { emit: (event: AgentSessionTurnCompletionEvent) => void }) => {
          emit = subscriber.emit
          return dispose
        }
      ),
      subscribe: vi.fn(async () => () => {}),
      currentWork: vi.fn(() => ({
        scope: { isCurrentItem: () => state.live, owesSend: () => false }
      })),
      history: vi.fn(async () => ({ ok: true, page: { queuedMessages: [] } })),
      journalReads: async () => ({
        operationWindow: async () => ({
          complete: true,
          snapshot: {
            submissions: [
              {
                clientMessageId: SEND.clientMessageId,
                fence: 1,
                payloadFingerprint: '',
                providerItemId: null,
                submittedAt: 1,
                resolvedAt: 1,
                ...state.submission
              }
            ],
            items: [
              {
                ...row,
                itemId: opener,
                sequence: 1,
                turnScope: { kind: 'thread' },
                body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Go' }] }
              },
              ...(state.submission.dispatchState === 'rejected'
                ? []
                : [
                    {
                      ...row,
                      itemId: TURN_ITEM,
                      sequence: 2,
                      turnScope: { kind: 'thread' },
                      body: { kind: 'turn', turnId: 't1', userItemId: opener, ...state.turn }
                    },
                    {
                      ...row,
                      itemId: 'i1',
                      sequence: 3,
                      turnScope: { kind: 'turn', turnItemId: TURN_ITEM },
                      body: {
                        kind: 'message',
                        role: 'assistant',
                        blocks: [{ type: 'text', text: 'Done.' }]
                      }
                    }
                  ]),
              ...(state.question
                ? [
                    {
                      ...row,
                      itemId: 'q1',
                      sequence: 4,
                      turnScope: { kind: 'turn', turnItemId: TURN_ITEM },
                      body: {
                        kind: 'question',
                        question: 'Which branch?',
                        options: [],
                        resolution: { state: state.question === 'pending' ? 'pending' : 'answered' }
                      }
                    }
                  ]
                : [])
            ]
          }
        })
      })
    }
    const end = (sessionId: string) =>
      emit({
        type: 'completion',
        completion: {
          scope: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'folder:w1',
            workspaceKind: 'folder'
          },
          sessionId,
          turnId: 't1',
          outcome: 'success',
          completedAt: 1
        }
      })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements the host members the watch reads.
    const watch = watchBotTurnEnds(host as unknown as Parameters<typeof watchBotTurnEnds>[0])
    return {
      watch,
      state,
      end,
      emit: (event: AgentSessionTurnCompletionEvent) => emit(event),
      dispose
    }
  }

  it('reads a turn that ended before the run asked, and only its own answer', async () => {
    const { watch, end, dispose } = feed()
    end('other-session')

    expect(await watch.next(SEND)).toEqual({ outcome: 'success', message: 'Done.' })
    expect(dispose).toHaveBeenCalled()
  })

  it('waits past a turn that stopped on a question for the user', async () => {
    const { watch, state, end } = feed()
    state.question = 'pending'
    const next = watch.next(SEND)
    let settled = false
    void next.then(() => (settled = true))
    await vi.waitFor(() => expect(settled).toBe(false))

    state.question = 'answered'
    end(SESSION)
    await expect(next).resolves.toMatchObject({ outcome: 'success' })
  })

  it('does not wait on a question an agent that has since stopped left behind', async () => {
    const { watch, state } = feed()
    state.question = 'pending'
    state.live = false

    await expect(watch.next(SEND)).resolves.toEqual({ outcome: 'success', message: 'Done.' })
  })

  it('ends on a failure even while a question waits', async () => {
    const { watch, state } = feed()
    state.question = 'pending'
    state.turn = { state: 'completed', outcome: 'failure' }

    await expect(watch.next(SEND)).resolves.toMatchObject({ outcome: 'failure' })
  })

  it('fails a run whose message the agent refused before any turn', async () => {
    const { watch, state } = feed()
    state.submission = {
      dispatchState: 'rejected',
      reason: "You've hit your usage limit.",
      answeredInTurn: null
    }

    await expect(watch.next(SEND)).resolves.toEqual({ outcome: 'failure', message: '' })
  })

  it('fails the run when the feed ends before its turn does', async () => {
    const { watch, state, emit } = feed()
    state.turn = { state: 'running' }
    emit({ type: 'end' })

    await expect(watch.next(SEND)).rejects.toThrow('Orca stopped watching this run')
  })
})

describe('postConnectorBotMessage', () => {
  it("posts to the bot's posts route and reads its empty answer", async () => {
    const call = vi.fn()
    call.mockResolvedValue({ ok: true, value: undefined })

    await postConnectorBotMessage(
      { call },
      'bot-1',
      { postId: 'run-1', channelId: 'C123', text: 'hi' },
      new AbortController().signal,
      Math.random
    )

    expect(call).toHaveBeenCalledWith(
      `${CONNECTOR_PATHS.bots}/bot-1/posts`,
      { v: 1, postId: 'run-1', channelId: 'C123', text: 'hi' },
      expect.anything(),
      expect.anything()
    )
  })

  it("comments on a Linear issue through the bot's Linear comments route", async () => {
    const call = vi.fn()
    call.mockResolvedValue({ ok: true, value: undefined })

    await postConnectorBotMessage(
      { call },
      'bot-1',
      { postId: 'run-1', issue: 'ENG-123', text: 'hi' },
      new AbortController().signal,
      Math.random
    )

    expect(call).toHaveBeenCalledWith(
      `${CONNECTOR_PATHS.bots}/bot-1/linear/comments`,
      { v: 1, postId: 'run-1', issue: 'ENG-123', text: 'hi' },
      expect.anything(),
      expect.anything()
    )
  })
})
