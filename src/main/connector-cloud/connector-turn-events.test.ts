import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { owedPage } from './connector-reply-journal.test-fixture'
import { z } from 'zod'
import { CONNECTOR_CLIENT_LIMITS } from '../../shared/connectors/connector-cloud-contract'
import type { ConversationSnapshot } from '../external-conversations/external-conversation-events'
import { ConnectorTurnEvents } from './connector-turn-events'

const conversation = { source: 'slack', externalId: 'T1:C9:1' } as const
let userDataPath: string

const prompt = (promptId: string) =>
  ({
    kind: 'prompt',
    conversation,
    worktreeId: 'wt',
    paneKey: 'tab:1',
    prompt: { kind: 'unsupported', promptId }
  }) as const
const turnEnded = (turnId: number) =>
  ({
    kind: 'turn-ended',
    conversation,
    worktreeId: 'wt',
    paneKey: 'tab:1',
    turnId,
    stopReason: null,
    at: turnId
  }) as const

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-events-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await ConnectorTurnEvents.settled()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('ConnectorTurnEvents', () => {
  it('never drops a new hello’s snapshot, even behind a head still in flight', () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    events.observe(prompt('old'))
    expect(events.next(1)?.batch).toHaveLength(1)
    events.observe({ kind: 'snapshot', conversations: [] })
    for (let index = 0; index < 600; index++) {
      events.observe(prompt(String(index)))
    }
    const head = events.next(2)
    expect(head?.stamp.seq).toBe(0)
    expect(head?.batch[0]).toEqual({ kind: 'snapshot', conversations: [] })
  })

  it('logs a turn end left out for its unknown start, without ids or text', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    events.observe({
      ...turnEnded(1),
      turnId: null,
      stopReason: 'success',
      lastAssistantMessage: 'Private words'
    })
    expect(events.next(1)).toBeNull()
    expect(info.mock.calls).toEqual([
      ['[connector] turn end without its start left out', { hadReply: true, stopReason: 'success' }]
    ])
    info.mockClear()
    events.observe(turnEnded(2))
    expect(info).not.toHaveBeenCalled()
  })

  it('keeps 200 turn ends in all, never trimming the head in flight', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    for (let turn = 1; turn <= 50; turn++) {
      events.observe(turnEnded(turn))
    }
    expect(events.next(1)?.batch).toHaveLength(50)
    for (let turn = 51; turn <= 300; turn++) {
      events.observe(turnEnded(turn))
    }
    await ConnectorTurnEvents.settled()
    const { account, turnEnds: stored } = z
      .object({ account: z.string(), turnEnds: z.array(z.object({ turnId: z.number() })) })
      .parse(JSON.parse(readFileSync(join(userDataPath, 'connector-turn-outbox.json'), 'utf8')))
    expect(account).toBe('ada')
    expect(stored.map(({ turnId }) => turnId)).toEqual([
      ...Array.from({ length: 50 }, (_, index) => index + 1),
      ...Array.from({ length: 150 }, (_, index) => index + 151)
    ])
  })

  it('keeps a turn end’s origin and pull request links through a restart', () => {
    const links = [{ url: 'https://github.com/org/repo/pull/7', title: 'Pull request #7' }]
    new ConnectorTurnEvents(userDataPath, 'ada').observe({
      ...turnEnded(1),
      origin: 'local',
      links
    })
    expect(new ConnectorTurnEvents(userDataPath, 'ada').next(1)?.batch).toEqual([
      expect.objectContaining({ turnId: 1, origin: 'local', links })
    ])
  })

  it('offers a prompt too large for one event as one only Orca can answer', () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    const question = 'x'.repeat(CONNECTOR_CLIENT_LIMITS.maxEventBytes)
    events.observe({
      ...prompt('big'),
      prompt: { kind: 'question', promptId: 'big', question, options: [] }
    })
    expect(events.next(1)?.batch).toEqual([
      expect.objectContaining({ prompt: { kind: 'unsupported', promptId: 'big' } })
    ])
  })

  it('tells a prompt answered in Orca as the same prompt, marked answered', () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    events.observe(prompt('p1'))
    events.observe({ ...prompt('p1'), answered: true })
    expect(events.next(2)?.batch).toEqual([
      {
        kind: 'prompt',
        conversation,
        paneKey: 'tab:1',
        prompt: { kind: 'unsupported', promptId: 'p1' }
      },
      {
        kind: 'prompt',
        conversation,
        paneKey: 'tab:1',
        prompt: { kind: 'unsupported', promptId: 'p1' },
        answered: true
      }
    ])
  })

  it('names each conversation’s latest turn in the snapshot', () => {
    const now = 1_800_000_000_000
    vi.useFakeTimers({ toFake: ['Date'], now })
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    const entry = { conversation, worktreeId: 'wt', paneKey: 'tab:1', agent: 'claude' } as const
    events.observe({
      kind: 'snapshot',
      conversations: [
        { ...entry, working: true, prompt: null, turnId: 200, activeAt: 0 },
        {
          ...entry,
          paneKey: 'tab:2',
          working: false,
          prompt: null,
          turnId: null,
          activeAt: now
        }
      ]
    })
    expect(events.next(1)?.batch[0]).toEqual({
      kind: 'snapshot',
      conversations: [
        {
          conversation,
          paneKey: 'tab:1',
          agent: 'claude',
          working: true,
          prompt: null,
          turnId: 200
        },
        { conversation, paneKey: 'tab:2', agent: 'claude', working: false, prompt: null }
      ]
    })
  })

  describe('a long answer', () => {
    const ended = (text: string) =>
      ({
        kind: 'turn-ended',
        conversation,
        worktreeId: 'wt',
        paneKey: 'tab:1',
        turnId: 5,
        at: 6,
        stopReason: 'success',
        lastAssistantMessage: text
      }) as const
    const sent = (events: ConnectorTurnEvents) => {
      const [event] = events.next(1)?.batch ?? []
      return event?.kind === 'turn-ended' ? (event.lastAssistantMessage ?? '') : ''
    }
    const NOTE = '\n\n_… cut short here. The full answer is in Orca._'

    it('goes whole to a cloud that lists answers.long, and cut to 8 KB to one that doesn’t', () => {
      const answer = 'a'.repeat(20_000)
      const newer = new ConnectorTurnEvents(userDataPath, 'ada')
      newer.useCloudFeatures(new Set(['answers.long']))
      newer.observe(ended(answer))
      expect(sent(newer)).toBe(answer)

      const older = new ConnectorTurnEvents(userDataPath, 'grace')
      older.useCloudFeatures(new Set(['workers']))
      older.observe(ended(answer))
      expect(sent(older)).toBe(`${'a'.repeat(8_137)}${NOTE}`)
    })

    it('is cut for the cloud it finally reaches, when that one takes less than the one it was written for', () => {
      const events = new ConnectorTurnEvents(userDataPath, 'ada')
      events.useCloudFeatures(new Set(['answers.long']))
      events.observe(ended('a'.repeat(20_000)))
      events.useCloudFeatures(new Set(['workers']), 2)
      expect(sent(events)).toBe(`${'a'.repeat(8_137)}${NOTE}`)
    })

    it('is cut the same way through /replies, for a cloud that takes neither it nor reply events', async () => {
      const posted: string[] = []
      const rows = [
        {
          account: 'ada',
          deliveryId: 'd1',
          conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
          sessionId: 'chat-1',
          epoch: 'e',
          messageId: 'm-d1',
          queued: false,
          fill: {
            outcome: 'answered' as const,
            answerDeliveryId: 'd1',
            prose: 'a'.repeat(20_000),
            filledAt: 40
          }
        }
      ]
      const replies = (features: string[]) => {
        const events = new ConnectorTurnEvents(userDataPath, 'ada', undefined, {
          journal: () => ({
            read: async () => rows,
            readOwed: async (account, after, limit) => owedPage(rows, account, after, limit),
            fillOutcomes: async () => false,
            sent: async () => {}
          }),
          onOwed: () => {},
          post: async (reply) => {
            posted.push(reply.text)
            return { ok: true, value: { status: 'queued' } }
          },
          hostName: () => 'build-box'
        })
        events.useCloudFeatures(new Set(features), 1)
        events.useReplyFlush(() => {})
        return events.drainReplies()
      }
      await replies(['workers'])
      await replies(['workers', 'answers.long'])
      expect(posted).toEqual([`${'a'.repeat(8_137)}${NOTE}`, 'a'.repeat(20_000)])
    })

    it('never goes over 32 KB', () => {
      const events = new ConnectorTurnEvents(userDataPath, 'ada')
      events.useCloudFeatures(new Set(['answers.long']))
      events.observe(ended('a'.repeat(50_000)))
      expect(sent(events)).toBe(`${'a'.repeat(32_713)}${NOTE}`)
    })
  })

  describe('what a turn is doing', () => {
    const activity = (text: string, paneKey = 'tab:1') =>
      ({ kind: 'activity', conversation, worktreeId: 'wt', paneKey, turnId: 5, text }) as const

    it('goes only to a cloud that lists turn.activity', () => {
      const older = new ConnectorTurnEvents(userDataPath, 'ada')
      older.useCloudFeatures(new Set(['workers']))
      older.observe(activity('Running pnpm test'))
      expect(older.next(1)).toBeNull()

      const newer = new ConnectorTurnEvents(userDataPath, 'ada')
      newer.useCloudFeatures(new Set(['turn.activity']))
      newer.observe(activity('Running pnpm test'))
      expect(newer.next(1)?.batch).toEqual([
        { kind: 'activity', conversation, paneKey: 'tab:1', turnId: 5, text: 'Running pnpm test' }
      ])
    })

    it('keeps only each chat’s newest unsent word, and owes no snapshot for the rest', () => {
      const events = new ConnectorTurnEvents(userDataPath, 'ada')
      events.useCloudFeatures(new Set(['turn.activity']))
      events.observe(activity('one'))
      events.observe(activity('other chat', 'tab:2'))
      events.observe(activity('two'))
      events.observe(activity('three'))
      expect(events.next(1)?.batch.map((event) => 'text' in event && event.text)).toEqual([
        'other chat',
        'three'
      ])
      expect(events.needsSnapshot).toBe(false)
    })
  })

  describe('a conversation’s workers', () => {
    const workers = { kind: 'workers', conversation, worktreeId: 'wt', paneKey: 'tab:1' } as const
    const snapshot = (workersRunning?: boolean, activeAt = Date.now()): ConversationSnapshot => ({
      kind: 'snapshot',
      conversations: [
        {
          conversation,
          worktreeId: 'wt',
          paneKey: 'tab:1',
          agent: 'claude',
          working: false,
          prompt: null,
          turnId: 5,
          activeAt,
          ...(workersRunning === undefined ? {} : { workersRunning })
        }
      ]
    })

    it('go only to a cloud that lists them; an older one keeps today’s done', () => {
      const older = new ConnectorTurnEvents(userDataPath, 'ada')
      older.useCloudFeatures(new Set(['review']))
      older.observe({ ...workers, running: true })
      expect(older.next(1)).toBeNull()

      const newer = new ConnectorTurnEvents(userDataPath, 'ada')
      newer.useCloudFeatures(new Set(['review', 'workers']))
      newer.observe({ ...workers, running: true })
      expect(newer.next(1)?.batch).toEqual([
        { kind: 'workers', conversation, paneKey: 'tab:1', running: true }
      ])
    })

    it('ride a snapshot once read, and count as recent activity', () => {
      const events = new ConnectorTurnEvents(userDataPath, 'ada')
      events.observe(snapshot(true, 0))
      const head = events.next(1)
      expect(head?.batch[0]).toMatchObject({
        conversations: [{ paneKey: 'tab:1', working: false, workersRunning: true }]
      })
      if (head) {
        events.accepted(head.stamp)
      }

      events.observe(snapshot())
      const [unread] = z
        .object({ conversations: z.array(z.record(z.string(), z.unknown())) })
        .parse(events.next(2)?.batch[0]).conversations
      expect(unread).not.toHaveProperty('workersRunning')
    })
  })
})

describe('Slack-bound words in events', () => {
  const github = { source: 'github', externalId: 'o/r#1' } as const
  const raw = 'Report: ![side by side](~/.orca/reports/r/side.png)'

  it('names only files in Slack answers and activity; GitHub keeps every word', () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    events.useCloudFeatures(new Set(['turn.activity']))
    for (const where of [conversation, github]) {
      // One pane each: a pane's newer activity replaces its older one.
      const at = { worktreeId: 'wt', paneKey: where === github ? 'tab:2' : 'tab:1' }
      events.observe({ ...turnEnded(1), ...at, conversation: where, lastAssistantMessage: raw })
      events.observe({
        kind: 'activity',
        conversation: where,
        ...at,
        turnId: 1,
        text: 'Reading /Users/ada/r/report.html',
        steps: [{ title: 'Write /tmp/out.md', status: 'pending' }]
      })
    }
    const batch = events.next(1)?.batch ?? []
    const from = (source: string) =>
      batch.filter((event) => 'conversation' in event && event.conversation.source === source)
    expect(from('slack')).toEqual([
      expect.objectContaining({ kind: 'turn-ended', lastAssistantMessage: 'Report: side by side' }),
      expect.objectContaining({
        kind: 'activity',
        text: 'Reading report.html',
        steps: [{ title: 'Write out.md', status: 'pending' }]
      })
    ])
    expect(from('github')).toEqual([
      expect.objectContaining({ kind: 'turn-ended', lastAssistantMessage: raw }),
      expect.objectContaining({ kind: 'activity', text: 'Reading /Users/ada/r/report.html' })
    ])
  })

  it('names only files in a Slack turn end saved before this check, through a resend and its ack', async () => {
    const file = join(userDataPath, 'connector-turn-outbox.json')
    const stored = (where: typeof conversation | typeof github, turnId: number) => ({
      kind: 'turn-ended',
      conversation: where,
      paneKey: 'tab:1',
      turnId,
      at: turnId,
      stopReason: null,
      lastAssistantMessage: raw
    })
    writeFileSync(
      file,
      JSON.stringify({ account: 'ada', turnEnds: [stored(conversation, 1), stored(github, 2)] })
    )
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    const sent = [
      { ...stored(conversation, 1), lastAssistantMessage: 'Report: side by side' },
      stored(github, 2)
    ]
    const first = events.next(1)
    expect(first?.batch).toEqual(sent)
    // Unanswered, the same head goes again under the same stamp.
    const again = events.next(1)
    expect(again?.stamp).toEqual(first?.stamp)
    expect(again?.batch).toEqual(sent)
    events.accepted(again!.stamp)
    expect(events.next(1)).toBeNull()
    await ConnectorTurnEvents.settled()
    const left = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).turnEnds : []
    expect(left).toEqual([])
  })

  it('names only files in a stored Slack answer, on either reply route', async () => {
    const rows = [conversation, github].map((where, index) => ({
      account: 'ada',
      deliveryId: `d${index}`,
      conversation: where,
      sessionId: 'chat-1',
      epoch: 'e',
      messageId: `m${index}`,
      queued: false,
      fill: {
        outcome: 'answered' as const,
        answerDeliveryId: `d${index}`,
        prose: 'Saved /Users/ada/r/report.html',
        filledAt: 1
      }
    }))
    const posted: { text: string; conversation: unknown }[] = []
    const events = new ConnectorTurnEvents(userDataPath, 'ada', undefined, {
      journal: () => ({
        read: async () => rows,
        readOwed: async (account, after, limit) => owedPage(rows, account, after, limit),
        fillOutcomes: async () => false,
        sent: async () => {}
      }),
      onOwed: () => {},
      post: async (body) => {
        posted.push(body)
        return { ok: true, value: { status: 'queued' } }
      },
      hostName: () => 'box'
    })
    events.useReplyFlush(() => {})
    events.useCloudFeatures(new Set())
    await events.drainReplies()
    expect(posted.map(({ conversation: where, text }) => [where, text])).toEqual([
      [conversation, 'Saved report.html'],
      [github, 'Saved /Users/ada/r/report.html']
    ])

    const outbox = new ConnectorTurnEvents(userDataPath, 'ada', undefined, {
      journal: () => ({
        read: async () => rows,
        readOwed: async (account, after, limit) => owedPage(rows, account, after, limit),
        fillOutcomes: async () => false,
        sent: async () => {}
      }),
      onOwed: () => {},
      post: async () => ({ ok: true, value: { status: 'queued' } }),
      hostName: () => 'box'
    })
    outbox.useReplyFlush(() => {})
    outbox.useCloudFeatures(new Set(['replies.outbox']), 1)
    await outbox.drainReplies()
    expect(
      (outbox.next(1)?.batch ?? []).flatMap((event) =>
        event.kind === 'reply' ? [[event.conversation, event.prose]] : []
      )
    ).toEqual([
      [conversation, 'Saved report.html'],
      [github, 'Saved /Users/ada/r/report.html']
    ])
  })
})
