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

afterEach(() => {
  vi.useRealTimers()
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

  it('keeps 200 turn ends in all, never trimming the head in flight', () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    for (let turn = 1; turn <= 50; turn++) {
      events.observe(turnEnded(turn))
    }
    expect(events.next(1)?.batch).toHaveLength(50)
    for (let turn = 51; turn <= 300; turn++) {
      events.observe(turnEnded(turn))
    }
    const { account, turnEnds: stored } = z
      .object({ account: z.string(), turnEnds: z.array(z.unknown()) })
      .parse(JSON.parse(readFileSync(join(userDataPath, 'connector-turn-outbox.json'), 'utf8')))
    expect(account).toBe('ada')
    expect(stored).toHaveLength(200)
    expect(stored[0]).toMatchObject({ turnId: 1 })
    expect(stored.at(-1)).toMatchObject({ turnId: 300 })
  })

  it('asks for a snapshot once the caps drop an event, until the next snapshot arrives', () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    for (let index = 0; index < 500; index++) {
      events.observe(prompt(String(index)))
    }
    expect(events.needsSnapshot).toBe(false)
    events.observe(prompt('one too many'))
    expect(events.needsSnapshot).toBe(true)
    events.observe({ kind: 'snapshot', conversations: [] })
    expect(events.needsSnapshot).toBe(false)
  })

  it('restores only the turn ends its own account left on disk', () => {
    new ConnectorTurnEvents(userDataPath, 'ada').observe(turnEnded(1))
    expect(new ConnectorTurnEvents(userDataPath, 'grace').next(1)).toBeNull()
    expect(new ConnectorTurnEvents(userDataPath, 'ada').next(1)?.batch).toEqual([
      expect.objectContaining({ kind: 'turn-ended', turnId: 1 })
    ])
  })

  it('keeps a chat turn’s origin through a restart, so Orca-typed turns stay unmirrored', () => {
    new ConnectorTurnEvents(userDataPath, 'ada').observe({ ...turnEnded(1), origin: 'local' })
    expect(new ConnectorTurnEvents(userDataPath, 'ada').next(1)?.batch).toEqual([
      expect.objectContaining({ turnId: 1, origin: 'local' })
    ])
  })

  it('keeps a turn end’s pull request links through a restart', () => {
    const links = [{ url: 'https://github.com/org/repo/pull/7', title: 'Pull request #7' }]
    new ConnectorTurnEvents(userDataPath, 'ada').observe({ ...turnEnded(1), links })
    expect(new ConnectorTurnEvents(userDataPath, 'ada').next(1)?.batch).toEqual([
      expect.objectContaining({ turnId: 1, links })
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
