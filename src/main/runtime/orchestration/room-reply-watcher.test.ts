import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { OrchestrationDb } from './db/orchestration-db'
import { ensureRoomReplyWatcher } from './room-reply-watcher'

const aliceMember = 'orca_session_id:session_alice_0001'
const betaMember = 'orca_session_id:session_beta_0002'

type Subscriber = {
  includePrompts?: boolean
  onState?: (state: { sessionId: string; pendingPromptIds: readonly string[] }) => void
  emit: (event: AgentSessionTurnCompletionEvent) => void
}

const hostWith = (snapshotItems: unknown[] = []) => {
  const subscribers: Subscriber[] = []
  const sends: { sessionId: string; text: string }[] = []
  const host = {
    subscribeTurnCompletions: vi.fn((sub: Subscriber) => {
      subscribers.push(sub)
      return () => undefined
    }),
    journalSnapshot: vi.fn(async () => ({ items: snapshotItems })),
    send: vi.fn(
      async (
        _caller: unknown,
        message: { envelope?: { sessionId?: string }; body?: { blocks?: { text?: string }[] } }
      ) => {
        sends.push({
          sessionId: message.envelope?.sessionId ?? '',
          text: (message.body?.blocks ?? []).map((b) => b.text ?? '').join('\n')
        })
        return {
          ok: true,
          replayed: false,
          fence: 0,
          cursor: { epoch: 'e', sequence: 1 },
          value: {
            clientMessageId: `cm-${sends.length}`,
            submission: { dispatchState: 'accepted' }
          }
        }
      }
    ),
    waitForSendSettlement: vi.fn(async () => undefined)
  }
  return { host: host as unknown as StructuredAgentSessionHost, subscribers, sends }
}

const completionFor = (sessionId: string, turnId: string): AgentSessionTurnCompletionEvent => ({
  type: 'completion',
  completion: {
    scope: { kind: 'local', hostId: 'h', workspaceId: 'w' } as never,
    sessionId,
    turnId,
    outcome: { kind: 'success' } as never,
    completedAt: Date.now()
  }
})

const promptFor = (sessionId: string): AgentSessionTurnCompletionEvent => ({
  type: 'prompt',
  prompt: {
    scope: { kind: 'local', hostId: 'h', workspaceId: 'w' } as never,
    sessionId,
    promptId: 'prompt-1',
    raisedAt: Date.now()
  }
})

const assistantItem = (turnItemId: string, text: string) => ({
  itemId: `item-${turnItemId}`,
  revision: 0,
  sequence: 1,
  observedAt: 1,
  turnScope: { kind: 'turn' as const, turnItemId },
  body: {
    kind: 'message' as const,
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text }]
  }
})

const seedRoom = (db: OrchestrationDb) =>
  db.createRoom({
    name: 'demo',
    mode: 'everyone',
    members: [
      { memberId: aliceMember, name: 'alice', isAdmin: true },
      { memberId: betaMember, name: 'beta' }
    ]
  })

const seedAdminRoom = (db: OrchestrationDb) =>
  db.createRoom({
    name: 'admin-room',
    mode: 'admin',
    members: [
      { memberId: aliceMember, name: 'alice', isAdmin: true },
      { memberId: betaMember, name: 'beta' }
    ]
  })

describe('room-reply-watcher', () => {
  it('posts the member reply into the room when its turn completes', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = seedRoom(db)
    const { host, subscribers } = hostWith([assistantItem('turn-1', 'hello room')])
    ensureRoomReplyWatcher({ db, host })

    subscribers[0].emit(completionFor('session_alice_0001', 'turn-1'))
    await vi.waitFor(() => {
      const row = db.db
        .prepare(`SELECT who, text FROM room_log WHERE room_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(room.id) as { who: string; text: string } | undefined
      expect(row?.who).toBe('alice')
      expect(row?.text).toBe('hello room')
    })
  })

  it('ignores completions on sessions that belong to no member', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = seedRoom(db)
    const { host, subscribers } = hostWith([assistantItem('turn-1', 'noise')])
    ensureRoomReplyWatcher({ db, host })

    subscribers[0].emit(completionFor('session_stranger', 'turn-1'))
    await new Promise((r) => setTimeout(r, 30))
    const count = db.db
      .prepare(`SELECT COUNT(*) AS n FROM room_log WHERE room_id = ?`)
      .get(room.id) as { n: number }
    expect(count.n).toBe(0)
  })

  it('subscribes the host only once', () => {
    const db = new OrchestrationDb(':memory:')
    const { host } = hostWith()
    ensureRoomReplyWatcher({ db, host })
    ensureRoomReplyWatcher({ db, host })
    expect(host.subscribeTurnCompletions).toHaveBeenCalledTimes(1)
  })

  it('marks a member waiting while a prompt is pending and idle when it completes', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = seedRoom(db)
    const { host, subscribers } = hostWith([assistantItem('turn-1', 'after approval')])
    ensureRoomReplyWatcher({ db, host })

    expect(subscribers[0].includePrompts).toBe(true)
    subscribers[0].emit(promptFor('session_beta_0002'))
    await vi.waitFor(() => {
      expect(roomStatus(db, room.id, 'beta')).toBe('waiting')
    })

    subscribers[0].emit(completionFor('session_beta_0002', 'turn-1'))
    await vi.waitFor(() => {
      expect(roomStatus(db, room.id, 'beta')).toBe('idle')
    })
  })

  it('restores waiting state from the host attention snapshot', () => {
    const db = new OrchestrationDb(':memory:')
    const room = seedRoom(db)
    const { host, subscribers } = hostWith()
    ensureRoomReplyWatcher({ db, host })

    subscribers[0].onState?.({
      sessionId: 'session_beta_0002',
      pendingPromptIds: ['prompt-1']
    })
    expect(roomStatus(db, room.id, 'beta')).toBe('waiting')
  })

  it('in admin mode, a non-admin reply nudges the admin to summarize', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = seedAdminRoom(db)
    const { host, subscribers, sends } = hostWith([assistantItem('turn-1', 'I looked it up')])
    ensureRoomReplyWatcher({ db, host })

    subscribers[0].emit(completionFor('session_beta_0002', 'turn-1'))
    await vi.waitFor(() => {
      const adminSend = sends.find((s) => s.sessionId === 'session_alice_0001')
      expect(adminSend?.text).toContain('beta just replied')
      expect(adminSend?.text).toContain('I looked it up')
    })
    expect(room.mode).toBe('admin')
  })

  it('in everyone mode, a reply does not trigger a report-back', async () => {
    const db = new OrchestrationDb(':memory:')
    seedRoom(db)
    const { host, subscribers, sends } = hostWith([assistantItem('turn-1', 'hello')])
    ensureRoomReplyWatcher({ db, host })

    subscribers[0].emit(completionFor('session_beta_0002', 'turn-1'))
    await new Promise((r) => setTimeout(r, 30))
    expect(sends).toHaveLength(0)
  })

  it("the admin's own reply does not loop back to itself", async () => {
    const db = new OrchestrationDb(':memory:')
    seedAdminRoom(db)
    const { host, subscribers, sends } = hostWith([assistantItem('turn-1', 'admin said')])
    ensureRoomReplyWatcher({ db, host })

    subscribers[0].emit(completionFor('session_alice_0001', 'turn-1'))
    await new Promise((r) => setTimeout(r, 30))
    expect(sends).toHaveLength(0)
  })
})

function roomStatus(db: OrchestrationDb, roomId: string, name: string): string | undefined {
  return (
    db.db
      .prepare(`SELECT status FROM room_members WHERE room_id = ? AND name = ?`)
      .get(roomId, name) as { status?: string } | undefined
  )?.status
}
