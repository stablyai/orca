import type { OrchestrationDb } from './db'
import type { RoomMemberRow, RoomWithMembers } from './db/rooms/room-store'

// Host-side group tools for room admins (the ds-bot Main Bot pattern): an admin
// emits fenced JSON blocks, the turn-completion watcher executes them against the
// room store, and the results come back as its next turn. No prompt parsing of
// user text; only an admin member's own reply can carry tool calls.
export const ROOM_TOOL_FENCE = 'orca-room-tool'
export const MAIN_BOT_ROOM_NAME = 'Orca HQ'
export const MAIN_BOT_NAME = 'Orca Admin'
export const ADMIN_TOOL_LIMIT = 5

export const MAIN_BOT_TOOL_DOC = [
  'Group tools: when the user asks for group work (create a group, add a bot, list groups, send a message into a group), act now by emitting one fenced tool block per action:',
  '```orca-room-tool',
  '{"tool": "room_create", "name": "hunt", "mode": "admin", "notice": "Reviewers compare notes before answering."}',
  '```',
  'Available tools (JSON args in the fence):',
  '- room_list {}: list every group with its members.',
  '- room_create {"name", "mode"?: "admin"|"everyone", "notice"?}: start a group. New bots spawn under this room unless told otherwise.',
  '- room_bot_create {"room", "name", "agent"?: "claude"|"codex"|"gemini"|"opencode"|"aider", "model"?, "effort"?, "instructions"?, "isAdmin"?}: spawn a fresh bot straight into a room. Prefer this over asking the user to open sessions.',
  '- room_send {"room", "text"}: speak into a group as Orca; its members answer.',
  '- room_member_add {"room", "memberId", "name", "isAdmin"?}: seat an existing agent session (orca_session_id:<id>) in a room.',
  '- room_member_remove {"room", "memberId"}: remove a member by name or id.',
  '- room_log {"room", "limit"?}: read the latest lines of a group.',
  'Rooms are found by name or id. After your tools run you get their results as your next message: say what happened briefly, in one or two short messages. Reply [PASS] when you have nothing new to add.'
].join('\n')

export const MAIN_BOT_INSTRUCTIONS = [
  'You are Orca Admin. The user talks to you here to manage bots and group chats with plain words.',
  MAIN_BOT_TOOL_DOC,
  'Writing "@Name" calls that member next; "@all" calls every member. Keep chat replies short.'
].join('\n')

export type AdminToolCall = { tool: string; args: Record<string, unknown> }

const strArg = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function parseAdminToolCalls(text: string): AdminToolCall[] {
  const calls: AdminToolCall[] = []
  const pattern = new RegExp(`\`\`\`${ROOM_TOOL_FENCE}\\s*([\\s\\S]*?)\`\`\``, 'g')
  for (const match of text.matchAll(pattern)) {
    try {
      const parsed: unknown = JSON.parse(match[1])
      if (
        parsed &&
        typeof parsed === 'object' &&
        'tool' in parsed &&
        typeof parsed.tool === 'string'
      ) {
        const { tool, ...args } = parsed
        calls.push({ tool, args })
      }
    } catch {
      // A malformed block is the model's draft, not a call; skip it silently.
    }
    if (calls.length >= ADMIN_TOOL_LIMIT) {
      break
    }
  }
  return calls
}

export function stripToolBlocks(text: string): string {
  return text.replace(new RegExp(`\`\`\`${ROOM_TOOL_FENCE}\\s*[\\s\\S]*?\`\`\``, 'g'), '').trim()
}

export type AdminToolRuntime = {
  db: OrchestrationDb
  caller: RoomMemberRow
  defaultWorktree: string
  spawnBot: (args: {
    roomId: string
    name: string
    agent: string
    worktree: string
    instructions?: string
    isAdmin?: boolean
    model?: string
    effort?: string
  }) => Promise<{ memberId: string }>
  readLog: (roomId: string, limit: number) => { who: string; text: string }[]
  sendToRoom: (roomId: string, text: string) => Promise<void>
}

const TOOL_NAMES = [
  'room_list',
  'room_create',
  'room_bot_create',
  'room_send',
  'room_member_add',
  'room_member_remove',
  'room_log'
].join(', ')

function resolveRoom(db: OrchestrationDb, ref: string | undefined): RoomWithMembers | undefined {
  if (!ref) {
    return undefined
  }
  return db.getRoom(ref) ?? db.getRoomByName(ref)
}

function resolveMember(room: RoomWithMembers, ref: string): RoomMemberRow | undefined {
  const key = ref.toLowerCase()
  return room.members.find((m) => m.member_id === ref || m.name.toLowerCase() === key)
}

async function executeAdminToolCall(rt: AdminToolRuntime, call: AdminToolCall): Promise<string> {
  const args = call.args
  switch (call.tool) {
    case 'room_list': {
      const rooms = rt.db.listRooms()
      if (!rooms.length) {
        return 'No groups yet. Create one with room_create.'
      }
      return rooms
        .map(
          (r) =>
            `- "${r.name}" (${r.mode}, id ${r.id}): ${r.members.map((m) => `${m.name}${m.is_admin ? ' [admin]' : ''}`).join(', ') || 'empty'}`
        )
        .join('\n')
    }
    case 'room_create': {
      const name = strArg(args, 'name')
      if (!name) {
        return 'Failed: room_create needs a "name".'
      }
      const mode = args.mode === 'everyone' ? 'everyone' : 'admin'
      const room = rt.db.createRoom({
        name,
        mode,
        notice: strArg(args, 'notice'),
        worktree: rt.defaultWorktree
      })
      return `Created group "${room.name}" (id ${room.id}, mode ${room.mode}).`
    }
    case 'room_bot_create': {
      const room = resolveRoom(rt.db, strArg(args, 'room'))
      const name = strArg(args, 'name')
      if (!room) {
        return 'Failed: room_bot_create needs a "room" name or id I can find.'
      }
      if (!name) {
        return 'Failed: room_bot_create needs a "name" for the bot.'
      }
      const agent = strArg(args, 'agent') ?? 'claude'
      const worktree = strArg(args, 'worktree') || room.worktree || rt.defaultWorktree
      if (!worktree) {
        return 'Failed: no workspace to spawn under; ask the user which workspace to use.'
      }
      const spawned = await rt.spawnBot({
        roomId: room.id,
        name,
        agent,
        worktree,
        instructions: strArg(args, 'instructions'),
        isAdmin: args.isAdmin === true,
        ...(strArg(args, 'model') ? { model: strArg(args, 'model') } : {}),
        ...(strArg(args, 'effort') ? { effort: strArg(args, 'effort') } : {})
      })
      return `Bot "${name}" joined "${room.name}" as ${spawned.memberId}.`
    }
    case 'room_send': {
      const room = resolveRoom(rt.db, strArg(args, 'room'))
      const text = strArg(args, 'text')
      if (!room) {
        return 'Failed: room_send needs a "room" name or id I can find.'
      }
      if (!text) {
        return 'Failed: room_send needs "text".'
      }
      await rt.sendToRoom(room.id, text)
      return `Said into "${room.name}": ${text.slice(0, 120)}.`
    }
    case 'room_member_add': {
      const room = resolveRoom(rt.db, strArg(args, 'room'))
      const memberId = strArg(args, 'memberId')
      const name = strArg(args, 'name')
      if (!room) {
        return 'Failed: room_member_add needs a "room" name or id I can find.'
      }
      if (!memberId || !name) {
        return 'Failed: room_member_add needs "memberId" and "name".'
      }
      rt.db.addRoomMember(room.id, { memberId, name, isAdmin: args.isAdmin === true })
      return `Added "${name}" to "${room.name}".`
    }
    case 'room_member_remove': {
      const room = resolveRoom(rt.db, strArg(args, 'room'))
      const ref = strArg(args, 'memberId') ?? strArg(args, 'name')
      if (!room) {
        return 'Failed: room_member_remove needs a "room" name or id I can find.'
      }
      if (!ref) {
        return 'Failed: room_member_remove needs "memberId" (or "name").'
      }
      const member = resolveMember(room, ref)
      if (!member) {
        return `Failed: no member "${ref}" in "${room.name}".`
      }
      rt.db.removeRoomMember(room.id, member.member_id)
      return `Removed "${member.name}" from "${room.name}".`
    }
    case 'room_log': {
      const room = resolveRoom(rt.db, strArg(args, 'room'))
      if (!room) {
        return 'Failed: room_log needs a "room" name or id I can find.'
      }
      const rawLimit = typeof args.limit === 'number' ? args.limit : 20
      const limit = Math.min(Math.max(Math.floor(rawLimit), 1), 60)
      const lines = rt.readLog(room.id, limit)
      if (!lines.length) {
        return `"${room.name}" is quiet so far.`
      }
      return lines.map((l) => `${l.who}: ${l.text}`).join('\n')
    }
    default:
      return `Unknown tool "${call.tool}". Available: ${TOOL_NAMES}.`
  }
}

/** Run an admin member's tool calls; only a room admin's calls execute. */
export async function runAdminToolCalls(
  rt: AdminToolRuntime,
  text: string
): Promise<{ calls: AdminToolCall[]; results: string[] }> {
  if (rt.caller.is_admin !== 1) {
    return { calls: [], results: [] }
  }
  const calls = parseAdminToolCalls(text)
  const results: string[] = []
  for (const call of calls) {
    try {
      results.push(await executeAdminToolCall(rt, call))
    } catch (error) {
      results.push(`Failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { calls, results }
}
