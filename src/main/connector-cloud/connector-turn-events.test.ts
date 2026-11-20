import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
