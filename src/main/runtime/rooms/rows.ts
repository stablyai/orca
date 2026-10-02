import {
  EMPTY_ROOM_CONTEXT,
  ROOM_HARNESS_AGENTS,
  type Room,
  type RoomAttachment,
  type RoomDelivery,
  type RoomMessage,
  type RoomParticipant,
  type RoomPin,
  type RoomRole
} from '../../../shared/rooms'
import {
  parseRoomJson,
  roomAttemptHistorySchema,
  roomContextSchema,
  roomMetadataSchema,
  roomProviderSessionSchema
} from './row-json'

export type RoomRow = Record<string, unknown>

function literal<const T extends string>(value: unknown, values: readonly T[]): T {
  const found = values.find((candidate) => candidate === value)
  if (found === undefined) {
    throw new Error('room_invalid_row_value')
  }
  return found
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : number(value)
}

export function roomFromRow(row: RoomRow): Room {
  return {
    id: string(row.id),
    projectId: string(row.project_id),
    worktreeId: nullableString(row.worktree_id),
    name: string(row.name),
    description: string(row.description),
    loopLimit: number(row.loop_limit),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at)
  }
}

export function roleFromRow(row: RoomRow): RoomRole {
  return {
    id: string(row.id),
    roomId: string(row.room_id),
    name: string(row.name),
    prompt: string(row.prompt),
    isPreset: number(row.is_preset) === 1,
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at)
  }
}

export function participantFromRow(row: RoomRow): RoomParticipant {
  const rawContext = parseRoomJson(row.context_json, roomContextSchema, {})
  return {
    id: string(row.id),
    roomId: string(row.room_id),
    identity: string(row.identity),
    displayName: string(row.display_name),
    actorKind: literal(row.actor_kind, ['user', 'agent']),
    agent: row.agent == null ? null : literal(row.agent, ROOM_HARNESS_AGENTS),
    roleId: nullableString(row.role_id),
    worktreeId: nullableString(row.worktree_id),
    paneKey: nullableString(row.pane_key),
    terminalHandle: nullableString(row.terminal_handle),
    providerSession: parseRoomJson(row.provider_session_json, roomProviderSessionSchema, null),
    processIncarnation: nullableString(row.process_incarnation),
    terminalSurfaceVisible: number(row.terminal_surface_visible) === 1,
    participation: row.participation === 'paused' ? 'paused' : 'active',
    state: literal(row.state, ['starting', 'online', 'busy', 'sleeping', 'offline', 'error']),
    context: { ...EMPTY_ROOM_CONTEXT, ...rawContext },
    lastSeenAt: nullableNumber(row.last_seen_at),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at)
  }
}

export function attachmentFromRow(row: RoomRow): RoomAttachment {
  return {
    id: string(row.id),
    messageId: string(row.message_id),
    fileName: string(row.file_name),
    mimeType: string(row.mime_type),
    byteSize: number(row.byte_size),
    localPath: string(row.local_path),
    createdAt: number(row.created_at)
  }
}

export function messageFromRow(
  row: RoomRow,
  mentions: string[] = [],
  attachments: RoomAttachment[] = []
): RoomMessage {
  return {
    id: string(row.id),
    roomId: string(row.room_id),
    sequence: number(row.sequence),
    senderId: nullableString(row.sender_id),
    senderIdentity: string(row.sender_identity),
    actorKind: literal(row.actor_kind, ['user', 'agent', 'system']),
    kind: literal(row.kind, ['chat', 'system', 'decision', 'proposal']),
    body: string(row.body),
    replyToId: nullableString(row.reply_to_id),
    rootMessageId: nullableString(row.root_message_id),
    hopCount: number(row.hop_count),
    metadata: parseRoomJson(row.metadata_json, roomMetadataSchema, {}),
    deliveryAttempted: number(row.delivery_attempted) === 1,
    queueEditing: nullableString(row.queue_edit_token) !== null,
    mentions,
    attachments,
    createdAt: number(row.created_at),
    editedAt: nullableNumber(row.edited_at),
    deletedAt: nullableNumber(row.deleted_at)
  }
}

export function deliveryFromRow(row: RoomRow | undefined): RoomDelivery {
  if (!row) {
    throw new Error('room_delivery_not_found')
  }
  return {
    id: string(row.id),
    messageId: string(row.message_id),
    participantId: string(row.participant_id),
    state: literal(row.state, ['pending', 'delivering', 'delivered', 'failed', 'suppressed']),
    attempts: number(row.attempts),
    error: nullableString(row.error),
    nextAttemptAt: number(row.next_attempt_at),
    deliveredAt: nullableNumber(row.delivered_at),
    providerTurnId: nullableString(row.provider_turn_id),
    responseMessageId: nullableString(row.response_message_id),
    respondedAt: nullableNumber(row.responded_at),
    intent: row.intent === 'steer' ? 'steer' : 'next',
    queuePosition: nullableNumber(row.queue_position) ?? undefined,
    phase: row.phase == null ? null : literal(row.phase, ['waking', 'submitting', 'awaiting-turn']),
    attemptHistory: parseRoomJson(row.attempt_history_json, roomAttemptHistorySchema, [])
  }
}

export function pinFromRow(row: RoomRow): RoomPin {
  return {
    roomId: string(row.room_id),
    messageId: string(row.message_id),
    status: literal(row.status, ['todo', 'done']),
    createdBy: string(row.created_by),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at)
  }
}
