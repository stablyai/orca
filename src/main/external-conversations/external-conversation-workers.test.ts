import { expect, it } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ConversationEvent } from './external-conversation-events'
import {
  ConversationWorkers,
  conversationWorkerActivities,
  type ConversationWorkerAnswer,
  type ConversationWorkerView
} from './external-conversation-workers'

const link: ExternalConversationLink = {
  source: 'slack',
  externalId: 'T1:C1:1.0:U0BOT',
  sessionId: 'chat-1',
  agent: 'claude',
  paneKey: 'pane',
  bot: { kind: 'bot', botId: 'bot-1' },
  createdAt: 0
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

it('reads a lead waiting on its own open workers as idle with helpers running', async () => {
  const activities = await conversationWorkerActivities(
    {
      workers: {
        read: async () =>
          new Map([
            [
              'chat-1',
              [
                // A worker that ended its turn to wait on the helpers it started.
                {
                  state: 'working',
                  activity: 'done',
                  pendingQuestion: false,
                  helpersRunning: true
                },
                { state: 'working', activity: 'working', pendingQuestion: true }
              ] as const
            ]
          ])
      }
    },
    [link]
  )
  expect(activities?.get('chat-1')).toEqual({ activity: 'idle', helpersRunning: true })
})

it('tells the watcher each read with its turn end, and emits running changes as before', async () => {
  let now = 1_000
  const answers: ConversationWorkerAnswer[] = [
    { activity: 'working', helpersRunning: false },
    { activity: 'idle', helpersRunning: true },
    'unread',
    { activity: 'none', helpersRunning: false }
  ]
  const events: ConversationEvent[] = []
  const views: [ConversationWorkerView, string[]][] = []
  const workers = new ConversationWorkers({
    now: () => now,
    setTimer: () => ({ cancel: () => {} }),
    linkedFor: () => ({ link, workspace: { worktreeId: 'wt', sshHostId: null } }),
    emit: (event) => events.push(event),
    workerActivities: async () => new Map([['chat-1', answers.shift()!]]),
    workersWatcher: {
      applied: (_pane, view, reasons) => views.push([view, [...reasons]]),
      watched: () => {},
      forgotten: () => {},
      cleared: () => {}
    }
  })
  await workers.check('pane', 'turn-ended', 42)
  now = 2_000
  await workers.check('pane', 'poll')
  now = 3_000
  await workers.check('pane', 'poll')
  await workers.check('pane', 'poll')
  await settle()
  expect(views).toEqual([
    [
      {
        activity: 'working',
        open: true,
        helpersRunning: false,
        since: 1_000,
        unverifiableSince: null,
        lastTurnId: 42
      },
      ['turn-ended']
    ],
    [
      {
        activity: 'idle',
        open: true,
        helpersRunning: true,
        since: 1_000,
        unverifiableSince: null,
        lastTurnId: 42
      },
      ['poll']
    ],
    // An unread answer keeps what was known: an idle pane stays open, not running.
    [
      {
        activity: 'idle',
        open: true,
        helpersRunning: true,
        since: 1_000,
        unverifiableSince: null,
        lastTurnId: 42
      },
      ['poll']
    ],
    [
      {
        activity: 'none',
        open: false,
        helpersRunning: false,
        since: 1_000,
        unverifiableSince: null,
        lastTurnId: 42
      },
      ['poll']
    ]
  ])
  expect(workers.viewOf('pane')).toEqual(views.at(-1)?.[0])
  const pane = { conversation: { source: 'slack', externalId: link.externalId }, paneKey: 'pane' }
  expect(events).toEqual([
    { kind: 'workers', ...pane, worktreeId: 'wt', running: true },
    { kind: 'workers', ...pane, worktreeId: 'wt', running: false }
  ])
})
