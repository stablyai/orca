import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CONNECTOR_CLIENT_LIMITS } from '../../shared/connector-cloud-contract'
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
})
