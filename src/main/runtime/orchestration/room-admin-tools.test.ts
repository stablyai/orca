import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import {
  parseAdminToolCalls,
  runAdminToolCalls,
  stripToolBlocks,
  type AdminToolRuntime
} from './room-admin-tools'

const adminMember = 'orca_session_id:session_admin_0001'
const botMember = 'orca_session_id:session_bot_0002'

const seed = (db: OrchestrationDb) =>
  db.createRoom({
    name: 'hq',
    mode: 'admin',
    worktree: 'id:wt-1',
    members: [
      { memberId: adminMember, name: 'boss', isAdmin: true },
      { memberId: botMember, name: 'worker' }
    ]
  })

const runtimeFor = (db: OrchestrationDb) => {
  const room = seed(db)
  const admin = room.members.find((m) => m.is_admin === 1)!
  const sent: { roomId: string; text: string }[] = []
  const rt: AdminToolRuntime = {
    db,
    caller: admin,
    defaultWorktree: room.worktree,
    spawnBot: vi.fn(async () => ({ memberId: 'orca_session_id:session_new_0003' })),
    readLog: (roomId, limit) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture selects the text columns created by the room schema.
      db.db
        .prepare(`SELECT who, text FROM room_log WHERE room_id = ? ORDER BY seq DESC LIMIT ?`)
        .all(roomId, limit)
        .toReversed() as { who: string; text: string }[],
    sendToRoom: vi.fn(async (roomId: string, text: string) => {
      sent.push({ roomId, text })
    })
  }
  return { db, room, rt, sent }
}

const fence = (json: string) => `\`\`\`orca-room-tool\n${json}\n\`\`\``

describe('room-admin-tools', () => {
  it('parses fenced calls and skips malformed blocks', () => {
    const text = [
      'on it',
      fence('{"tool": "room_list"}'),
      fence('not json'),
      fence('{"tool": "room_create", "name": "hunt"}')
    ].join('\n')
    const calls = parseAdminToolCalls(text)
    expect(calls.map((c) => c.tool)).toEqual(['room_list', 'room_create'])
  })

  it('strips tool blocks from the posted reply', () => {
    expect(stripToolBlocks(`hi\n${fence('{"tool":"room_list"}')}\nbye`)).toBe('hi\n\nbye')
  })

  it('refuses tool calls from a non-admin member', async () => {
    const { db, room, rt } = runtimeFor(new OrchestrationDb(':memory:'))
    const worker = room.members.find((m) => m.is_admin !== 1)!
    const { calls, results } = await runAdminToolCalls(
      { ...rt, caller: worker },
      fence('{"tool": "room_list"}')
    )
    expect(calls).toEqual([])
    expect(results).toEqual([])
    expect(db.listRooms()).toHaveLength(1)
  })

  it('lists rooms and creates one under the default worktree', async () => {
    const { db, rt } = runtimeFor(new OrchestrationDb(':memory:'))
    const listed = await runAdminToolCalls(rt, fence('{"tool": "room_list"}'))
    expect(listed.results[0]).toContain('"hq"')
    const created = await runAdminToolCalls(
      rt,
      fence('{"tool": "room_create", "name": "hunt", "mode": "everyone"}')
    )
    expect(created.results[0]).toContain('Created group "hunt"')
    expect(db.getRoomByName('hunt')?.worktree).toBe('id:wt-1')
  })

  it('spawns a bot into a room found by name', async () => {
    const { db, rt } = runtimeFor(new OrchestrationDb(':memory:'))
    const { results } = await runAdminToolCalls(
      rt,
      fence('{"tool": "room_bot_create", "room": "hq", "name": "scout", "agent": "codex"}')
    )
    expect(results[0]).toContain('Bot "scout" joined "hq"')
    expect(rt.spawnBot).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scout', agent: 'codex', worktree: 'id:wt-1' })
    )
    expect(db.getRoomByName('hq')?.members.map((m) => m.name)).not.toContain('scout')
  })

  it('passes a natural-language model choice to spawned bots', async () => {
    const { rt } = runtimeFor(new OrchestrationDb(':memory:'))
    await runAdminToolCalls(
      rt,
      fence(
        '{"tool": "room_bot_create", "room": "hq", "name": "planner", "model": "gpt-5.2-codex", "effort": "high"}'
      )
    )
    expect(rt.spawnBot).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.2-codex', effort: 'high' })
    )
  })

  it('sends, adds, removes, and reads the log', async () => {
    const { db, rt, sent } = runtimeFor(new OrchestrationDb(':memory:'))
    const room = db.getRoomByName('hq')!
    db.appendRoomLine(room.id, { who: 'boss', memberId: adminMember, text: 'hello' })
    const log = await runAdminToolCalls(rt, fence('{"tool": "room_log", "room": "hq"}'))
    expect(log.results[0]).toContain('boss: hello')
    const send = await runAdminToolCalls(
      rt,
      fence('{"tool": "room_send", "room": "hq", "text": "go"}')
    )
    expect(send.results[0]).toContain('Said into "hq"')
    expect(sent).toEqual([{ roomId: room.id, text: 'go' }])
    const add = await runAdminToolCalls(
      rt,
      fence(
        '{"tool": "room_member_add", "room": "hq", "memberId": "orca_session_id:x", "name": "extra"}'
      )
    )
    expect(add.results[0]).toContain('Added "extra"')
    const remove = await runAdminToolCalls(
      rt,
      fence('{"tool": "room_member_remove", "room": "hq", "memberId": "extra"}')
    )
    expect(remove.results[0]).toContain('Removed "extra"')
  })

  it('names unknown tools', async () => {
    const { rt } = runtimeFor(new OrchestrationDb(':memory:'))
    const { results } = await runAdminToolCalls(rt, fence('{"tool": "nope"}'))
    expect(results[0]).toContain('Unknown tool "nope"')
  })
})
