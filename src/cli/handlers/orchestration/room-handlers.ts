import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'

type RoomDto = {
  id: string
  name: string
  mode: string
  adminMemberId: string | null
  notice: string
  members: { memberId: string; name: string; isAdmin: boolean }[]
}

type RoomLineDto = {
  seq: number
  who: string
  memberId: string | null
  text: string
  kind: string | null
  createdAt: string
}

const roomSummary = (room: RoomDto) =>
  `${room.id} ${room.name} [${room.mode}] ${room.members.length} member${room.members.length === 1 ? '' : 's'}:${
    room.members.length
      ? ` ${room.members.map((m) => `${m.name}${m.isAdmin ? '*' : ''}`).join(', ')}`
      : ''
  }`

export const ORCHESTRATION_ROOM_HANDLERS: Record<string, CommandHandler> = {
  'orchestration room-create': async ({ flags, client, json }) => {
    const memberFlag = getOptionalStringFlag(flags, 'member') ?? ''
    const members = memberFlag
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((entry) => {
        const parts = entry.split(':')
        if (parts[0] === 'orca_session_id' && !parts[1]) {
          throw new RuntimeClientError(
            'invalid_argument',
            '--member orca_session_id needs a session id after the colon'
          )
        }
        const memberId =
          parts[0] === 'orca_session_id'
            ? `${parts.shift()}:${parts.shift()}`
            : (parts.shift() ?? '')
        const [name, isAdmin] = parts
        return { memberId, name: name ?? memberId, isAdmin: isAdmin === 'admin' }
      })
    const result = await client.call<{ room: RoomDto }>('orchestration.roomCreate', {
      name: getRequiredStringFlag(flags, 'name'),
      mode: getOptionalStringFlag(flags, 'mode'),
      notice: getOptionalStringFlag(flags, 'notice'),
      members: members.length ? members : undefined
    })
    printResult(result, json, (r) => `Room ${roomSummary(r.room)}`)
  },

  'orchestration room-list': async ({ client, json }) => {
    const result = await client.call<{ rooms: RoomDto[] }>('orchestration.roomList', {})
    printResult(result, json, (r) =>
      r.rooms.length ? r.rooms.map(roomSummary).join('\n') : 'No rooms.'
    )
  },

  'orchestration room-show': async ({ flags, client, json }) => {
    const result = await client.call<{ room: RoomDto }>('orchestration.roomShow', {
      id: getOptionalStringFlag(flags, 'id'),
      name: getOptionalStringFlag(flags, 'name')
    })
    printResult(result, json, (r) => roomSummary(r.room))
  },

  'orchestration room-delete': async ({ flags, client, json }) => {
    const result = await client.call<{ ok: true }>('orchestration.roomDelete', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, () => `Room deleted.`)
  },

  'orchestration room-add': async ({ flags, client, json }) => {
    const result = await client.call<{ room: RoomDto }>('orchestration.roomMemberAdd', {
      id: getRequiredStringFlag(flags, 'id'),
      memberId: getRequiredStringFlag(flags, 'member-id'),
      name: getRequiredStringFlag(flags, 'name'),
      isAdmin: flags.has('admin') ? true : undefined
    })
    printResult(result, json, (r) => roomSummary(r.room))
  },

  'orchestration room-bot-create': async ({ flags, client, json }) => {
    const result = await client.call<{
      memberId: string
      sessionId: string
      room: RoomDto | null
    }>('orchestration.roomBotCreate', {
      id: getRequiredStringFlag(flags, 'id'),
      worktree: getRequiredStringFlag(flags, 'worktree'),
      agent: getRequiredStringFlag(flags, 'agent'),
      model: getOptionalStringFlag(flags, 'model'),
      effort: getOptionalStringFlag(flags, 'effort'),
      name: getRequiredStringFlag(flags, 'name'),
      isAdmin: flags.has('admin') ? true : undefined,
      instructions: getOptionalStringFlag(flags, 'instructions')
    })
    printResult(
      result,
      json,
      (r) => `Bot ${r.memberId} in ${r.room ? roomSummary(r.room) : 'room'}`
    )
  },

  'orchestration room-remove': async ({ flags, client, json }) => {
    const result = await client.call<{ ok: true }>('orchestration.roomMemberRemove', {
      id: getRequiredStringFlag(flags, 'id'),
      memberId: getRequiredStringFlag(flags, 'member-id')
    })
    printResult(result, json, () => `Member removed.`)
  },

  'orchestration room-send': async ({ flags, client, json }) => {
    const result = await client.call<{
      seq: number
      slots: { memberId: string; name: string; status: string; note?: string }[]
    }>('orchestration.roomSend', {
      id: getOptionalStringFlag(flags, 'id'),
      name: getOptionalStringFlag(flags, 'name'),
      text: getRequiredStringFlag(flags, 'text'),
      from: getOptionalStringFlag(flags, 'from')
    })
    printResult(result, json, (r) => {
      const slots = r.slots.length
        ? r.slots.map((s) => `  ${s.name}: ${s.status}`).join('\n')
        : '  (nobody called)'
      return `Posted seq ${r.seq}; slots:\n${slots}`
    })
  },

  'orchestration room-post': async ({ flags, client, json }) => {
    const result = await client.call<{
      seq: number
      followUps: { memberId: string; name: string }[]
    }>('orchestration.roomPost', {
      id: getRequiredStringFlag(flags, 'id'),
      memberId: getRequiredStringFlag(flags, 'member-id'),
      text: getRequiredStringFlag(flags, 'text')
    })
    printResult(result, json, (r) =>
      r.followUps.length
        ? `Posted seq ${r.seq}; calls: ${r.followUps.map((m) => m.name).join(', ')}`
        : `Posted seq ${r.seq}`
    )
  },

  'orchestration room-log': async ({ flags, client, json }) => {
    const result = await client.call<{ room: RoomDto; lines: RoomLineDto[] }>(
      'orchestration.roomLog',
      {
        id: getRequiredStringFlag(flags, 'id'),
        memberId: getOptionalStringFlag(flags, 'member-id')
      }
    )
    printResult(result, json, (r) =>
      r.lines.length ? r.lines.map((l) => `[${l.seq}] ${l.who}: ${l.text}`).join('\n') : '(empty)'
    )
  },
  'orchestration room-ensure-main-bot': async ({ flags, client, json }) => {
    const result = await client.call<{ room: RoomDto; adminSeated: boolean }>(
      'orchestration.roomEnsureMainBot',
      {
        worktree: getRequiredStringFlag(flags, 'worktree'),
        agent: getOptionalStringFlag(flags, 'agent'),
        model: getOptionalStringFlag(flags, 'model'),
        effort: getOptionalStringFlag(flags, 'effort'),
        roomName: getOptionalStringFlag(flags, 'room-name'),
        botName: getOptionalStringFlag(flags, 'bot-name')
      }
    )
    printResult(
      result,
      json,
      (r) =>
        `Main bot ${r.adminSeated ? 'ready' : 'room ready, bot not seated'}: ${roomSummary(r.room)}`
    )
  }
}
