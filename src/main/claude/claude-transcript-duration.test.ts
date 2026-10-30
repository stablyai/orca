import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { selectStructuredAgentSettledTurns } from '../../shared/structured-agent-session-turn-timing'
import { isStructuredRewindTarget } from '../native-chat/agent-session-wire/structured-rewind-cut'
import {
  SID,
  at,
  attachment,
  chat,
  chatTurn,
  prompt,
  reply
} from './claude-transcript-catch-up-test-support'

// Captured CLI 2.1.308 ancestry: retain source identities, clocks, content and cycle boundaries.
// Only the session and first parent are rebound to the shared disk/journal fixture below.
const capturedDurationRows: Record<string, unknown>[] = [
  {
    type: 'user',
    uuid: '2d5c5bfb-2fb5-4d6e-9ad1-88e68f302f90',
    parentUuid: '55b46dc4-c498-4048-a31e-49484f80bf41',
    timestamp: '2026-10-22T23:31:49.253Z',
    isSidechain: false,
    promptSource: 'typed',
    message: {
      role: 'user',
      content: 'Reply exactly CLAUDE-AFTER-RECOVERY HARBOUR-1489 and CLI-REWIND-1552'
    }
  },
  {
    type: 'attachment',
    uuid: '600bd4b1-fbb0-4ef5-b9ab-13133119cf9d',
    parentUuid: '2d5c5bfb-2fb5-4d6e-9ad1-88e68f302f90',
    timestamp: '2026-10-22T23:31:49.253Z',
    isSidechain: false,
    attachment: {
      type: 'environment'
    }
  },
  {
    type: 'attachment',
    uuid: 'adb98c53-b869-4fb3-8e69-8a789c44a6ed',
    parentUuid: '600bd4b1-fbb0-4ef5-b9ab-13133119cf9d',
    timestamp: '2026-10-22T23:31:49.253Z',
    isSidechain: false,
    attachment: {
      type: 'agent_listing_delta'
    }
  },
  {
    type: 'attachment',
    uuid: '42c32240-2529-4d45-a2cf-c6d20e7a7495',
    parentUuid: 'adb98c53-b869-4fb3-8e69-8a789c44a6ed',
    timestamp: '2026-10-22T23:31:49.253Z',
    isSidechain: false,
    attachment: {
      type: 'total_tokens_reminder'
    }
  },
  {
    type: 'assistant',
    uuid: 'ab494260-8c70-4383-a859-e726caf272cf',
    parentUuid: '42c32240-2529-4d45-a2cf-c6d20e7a7495',
    timestamp: '2026-10-22T23:31:51.148Z',
    isSidechain: false,
    apiBlockIndex: 0,
    message: {
      id: 'msg_011CgJ9Xf5dhTUW23wbCZ1Yn',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'CLAUDE-AFTER-RECOVERY HARBOUR-1489 CLI-REWIND-1552'
        }
      ]
    }
  },
  {
    type: 'system',
    subtype: 'turn_duration',
    uuid: 'f47f4e0a-9816-473c-b80d-8ed90d0a21e2',
    parentUuid: 'ab494260-8c70-4383-a859-e726caf272cf',
    timestamp: '2026-10-22T23:31:51.167Z',
    isMeta: false,
    isSidechain: false,
    durationMs: 1938
  },
  {
    type: 'user',
    uuid: '37adf9f0-c934-4a98-8a8f-34cfacb53fce',
    parentUuid: 'f47f4e0a-9816-473c-b80d-8ed90d0a21e2',
    timestamp: '2026-10-22T23:32:10.885Z',
    isSidechain: false,
    promptSource: 'typed',
    message: {
      role: 'user',
      content: 'Use your Bash tool to run sleep 20, then reply exactly QUEUE-REWRITE-OPEN-1552.'
    }
  },
  {
    type: 'attachment',
    uuid: 'f11c17a7-5c52-43d6-9881-aed7b0092489',
    parentUuid: '37adf9f0-c934-4a98-8a8f-34cfacb53fce',
    timestamp: '2026-10-22T23:32:10.885Z',
    isSidechain: false,
    attachment: {
      type: 'total_tokens_reminder'
    }
  },
  {
    type: 'assistant',
    uuid: '47f13407-55d3-4226-91f2-431383ec38d5',
    parentUuid: 'f11c17a7-5c52-43d6-9881-aed7b0092489',
    timestamp: '2026-10-22T23:32:12.581Z',
    isSidechain: false,
    apiBlockIndex: 0,
    message: {
      id: 'msg_011CgJ9ZFsSZTgTX12zBVFp2',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01MoAGs3MB32fco3kjkHRF5B',
          name: 'Bash',
          input: {
            command: 'sleep 20',
            description: 'Wait 20 seconds'
          },
          caller: {
            type: 'direct'
          }
        }
      ]
    }
  },
  {
    type: 'user',
    uuid: '76d04699-d585-45f3-b04f-de029ec2afe7',
    parentUuid: '47f13407-55d3-4226-91f2-431383ec38d5',
    timestamp: '2026-10-22T23:32:32.660Z',
    isSidechain: false,
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: 'toolu_01MoAGs3MB32fco3kjkHRF5B',
          type: 'tool_result',
          content: '(Bash completed with no output)',
          is_error: false
        }
      ]
    }
  },
  {
    type: 'attachment',
    uuid: '282e98b1-5a75-46ff-be81-ebad78e28563',
    parentUuid: '76d04699-d585-45f3-b04f-de029ec2afe7',
    timestamp: '2026-10-22T23:32:21.679Z',
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      prompt: 'Include QUEUE-BEFORE-EDIT-1552 in your reply. Also include QUEUE-AFTER-EDIT-1552.',
      source_uuid: '080f8253-c2a1-41e1-b5e6-b6083f15c62d',
      delivery_id: 'ae32f76f-8553-4989-bbdc-b230447648e4',
      commandMode: 'prompt',
      origin: {
        kind: 'human'
      },
      timestamp: '2026-10-22T23:32:21.679Z',
      humanTurn: true
    }
  },
  {
    type: 'attachment',
    uuid: '7cbffe1d-5bde-4f7b-84d5-26c8cc3b55a8',
    parentUuid: '282e98b1-5a75-46ff-be81-ebad78e28563',
    timestamp: '2026-10-22T23:32:32.665Z',
    isSidechain: false,
    attachment: {
      type: 'total_tokens_reminder'
    }
  },
  {
    type: 'assistant',
    uuid: '6869216c-9a65-4acc-87e0-140b280200bf',
    parentUuid: '7cbffe1d-5bde-4f7b-84d5-26c8cc3b55a8',
    timestamp: '2026-10-22T23:32:37.224Z',
    isSidechain: false,
    apiBlockIndex: 0,
    message: {
      id: 'msg_011CgJ9asNQ7ZS2EUrFAGTtS',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'QUEUE-REWRITE-OPEN-1552 QUEUE-BEFORE-EDIT-1552 QUEUE-AFTER-EDIT-1552'
        }
      ]
    }
  },
  {
    type: 'system',
    subtype: 'turn_duration',
    uuid: '876beb5e-a4e4-4c4a-b842-6af45cfcf20b',
    parentUuid: '6869216c-9a65-4acc-87e0-140b280200bf',
    timestamp: '2026-10-22T23:32:37.231Z',
    isMeta: false,
    isSidechain: false,
    durationMs: 26349
  },
  {
    type: 'user',
    uuid: '0ad4bb3c-e775-496a-b4f2-f43f6a47446d',
    parentUuid: '876beb5e-a4e4-4c4a-b842-6af45cfcf20b',
    timestamp: '2026-10-22T23:33:10.191Z',
    isMeta: true,
    isSidechain: false,
    message: {
      role: 'user',
      content:
        "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>"
    }
  },
  {
    type: 'user',
    uuid: 'e9a0b4a2-082c-42c4-9f09-e054d6f83921',
    parentUuid: '0ad4bb3c-e775-496a-b4f2-f43f6a47446d',
    timestamp: '2026-10-22T23:33:10.190Z',
    isSidechain: false,
    message: {
      role: 'user',
      content:
        '<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>'
    }
  },
  {
    type: 'user',
    uuid: '8422612e-3899-4058-b3f8-b0b960ed86fc',
    parentUuid: 'e9a0b4a2-082c-42c4-9f09-e054d6f83921',
    timestamp: '2026-10-22T23:33:10.190Z',
    isSidechain: false,
    message: {
      role: 'user',
      content: '<local-command-stdout>See ya!</local-command-stdout>'
    }
  }
]

const key = (uuid: string) => agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid })
const queued = (uuid: string, parent: string, n: number) => ({
  ...attachment(uuid, parent),
  timestamp: at(n),
  attachment: {
    type: 'queued_command',
    source_uuid: uuid,
    commandMode: 'prompt',
    origin: { kind: 'human' },
    humanTurn: true,
    prompt: 'queued input'
  }
})
const boundary = (uuid: string, parentUuid: string, timestamp: string) => ({
  type: 'system',
  subtype: 'turn_duration',
  uuid,
  parentUuid,
  sessionId: SID,
  timestamp,
  durationMs: 'not a stopwatch'
})

describe('Claude historical cycle duration', () => {
  it('ends captured work at its boundary before later idle, next prompt and exit', async () => {
    const c = await chat()
    await c.live()
    const before = c.journal.snapshot()
    const handle = structuredClone(c.identity.providerHandle)
    const alias = key('p1')
    const canonical = c.journal.canonicalItemId(alias)
    await c.write([
      ...chatTurn,
      ...capturedDurationRows.map((row, i) => ({
        ...row,
        sessionId: SID,
        ...(i === 0 ? { parentUuid: 'a1' } : {})
      }))
    ])
    expect(await c.open('a1')).toBe(true)
    const snapshot = c.journal.snapshot()
    const turns = snapshot.items.filter((item) => item.body.kind === 'turn')
    const first = turns.find(
      (item) =>
        item.body.kind === 'turn' && item.body.turnId === '2d5c5bfb-2fb5-4d6e-9ad1-88e68f302f90'
    )!
    const second = turns.find(
      (item) =>
        item.body.kind === 'turn' && item.body.turnId === '37adf9f0-c934-4a98-8a8f-34cfacb53fce'
    )!
    const settled = selectStructuredAgentSettledTurns(snapshot.items, snapshot.submissions)
    const seconds = [first, second].map(
      (item) => settled.get(item.body.kind === 'turn' ? item.body.userItemId! : '')?.workedSeconds
    )
    console.info('captured historical seconds', seconds)
    expect(seconds).toEqual([1, 26])
    expect(first).toMatchObject({
      observedAt: 1792711909253,
      body: {
        startedAt: 1792711909253,
        completedAt: 1792711911167,
        state: 'completed'
      }
    })
    expect(second).toMatchObject({
      observedAt: 1792711930885,
      body: {
        startedAt: 1792711930885,
        completedAt: 1792711957231,
        state: 'completed'
      }
    })
    for (const turn of turns.slice(1)) {
      expect(turn.body).not.toHaveProperty('outcome')
      expect(turn.body).not.toHaveProperty('durationMs')
    }
    const queuedItem = c.journal.item(key('080f8253-c2a1-41e1-b5e6-b6083f15c62d'))!
    expect(queuedItem).toMatchObject({
      observedAt: 1792711941679,
      turnScope: {
        kind: 'turn',
        turnItemId: second.itemId
      }
    })
    expect(isStructuredRewindTarget(c.journal, queuedItem.itemId)).toBe(false)
    expect(isStructuredRewindTarget(c.journal, key('37adf9f0-c934-4a98-8a8f-34cfacb53fce'))).toBe(
      true
    )
    for (const item of before.items) {
      expect(c.journal.item(item.itemId)).toEqual(item)
    }
    expect(snapshot.submissions).toEqual(before.submissions)
    expect(c.identity.providerHandle).toEqual(handle)
    expect(c.journal.canonicalItemId(alias)).toBe(canonical)
    expect(c.rows()).toContain('user:<local-command-stdout>See ya!</local-command-stdout>')
    const exits = turns.filter(
      (item) =>
        item !== first &&
        item !== second &&
        !before.items.some((saved) => saved.itemId === item.itemId)
    )
    expect(exits).toHaveLength(2)
    for (const item of exits) {
      expect(item.body).not.toHaveProperty('completedAt')
    }
    expect(await c.open('a1')).toBe(true)
    expect(c.journal.snapshot()).toEqual(snapshot)
    expect(c.warn).not.toHaveBeenCalled()
  })

  it('uses only current-cycle work fallback and leaves unsupported endpoints untimed', async () => {
    const c = await chat()
    await c.live()
    await c.write([
      ...chatTurn,
      prompt('p2', 'a1', 'outside', 3),
      reply('a2', 'p2', 'tool', { type: 'tool_use', id: 'tool', name: 'Read', input: {} }, 4),
      {
        ...prompt('result', 'a2', '', 10),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'done' }]
        }
      },
      reply('older', 'result', 'older', { type: 'text', text: 'out of order' }, 8),
      {
        ...reply('bad-time', 'older', 'bad', { type: 'text', text: 'no clock' }, 9),
        timestamp: undefined
      },
      queued('later-queue', 'bad-time', 50),
      { ...attachment('environment', 'later-queue'), timestamp: at(60) },
      boundary('end2', 'environment', '1970-01-01T00:00:00.000Z'),
      prompt('empty', 'end2', 'no response', 70),
      boundary('empty-end', 'empty', 'malformed'),
      queued('unknown', 'empty-end', 75),
      reply('wake', 'unknown', 'wake', { type: 'text', text: 'background' }, 80),
      boundary('wake-end', 'wake', at(82)),
      prompt('no-work', 'wake-end', 'another empty cycle', 90),
      prompt('trailing', 'no-work', 'last request', 100),
      reply('last', 'trailing', 'last', { type: 'text', text: 'last response' }, 105),
      queued('trailing-queue', 'last', 120)
    ])
    expect(await c.open('a1')).toBe(true)
    const snapshot = c.journal.snapshot()
    const turn = (id: string) =>
      snapshot.items.find((item) => item.body.kind === 'turn' && item.body.turnId === id)!
    expect(turn('p2').body).toMatchObject({ completedAt: Date.parse(at(10)) })
    for (const id of ['empty', 'no-work']) {
      expect(turn(id).body).toMatchObject({ state: 'completed' })
      expect(turn(id).body).not.toHaveProperty('completedAt')
      expect(turn(id).body).not.toHaveProperty('durationMs')
    }
    expect(turn('wake').body).toMatchObject({
      completedAt: Date.parse(at(82)),
      userItemId: turn('wake').itemId
    })
    expect(turn('trailing').body).toMatchObject({ completedAt: Date.parse(at(105)) })
    expect(c.journal.item(key('unknown'))?.turnScope).toEqual({ kind: 'unknown' })
    expect(isStructuredRewindTarget(c.journal, key('unknown'))).toBe(false)
    const settled = selectStructuredAgentSettledTurns(snapshot.items, snapshot.submissions)
    expect(settled.get(key('empty'))).toBeNull()
    expect(settled.get(key('no-work'))).toBeNull()
    expect(settled.get(key('trailing'))?.workedSeconds).toBe(5)
    expect(await c.open('a1')).toBe(true)
    expect(c.journal.snapshot()).toEqual(snapshot)
    expect(c.warn).not.toHaveBeenCalled()
  })
})
