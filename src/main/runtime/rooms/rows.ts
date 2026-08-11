import {
  EMPTY_ROOM_CONTEXT,
  type Room,
  type RoomAttachment,
  type RoomContextSnapshot,
  type RoomDelivery,
  type RoomMessage,
  type RoomParticipant,
  type RoomPin,
  type RoomProviderSession,
  type RoomRole
} from '../../../shared/rooms'

export type RoomRow = Record<string, unknown>

export function parseRoomJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback
  }
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
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
    updatedAt: number(row.updated_at),
    archivedAt: nullableNumber(row.archived_at)
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
  const rawContext = parseRoomJson<Partial<RoomContextSnapshot>>(row.context_json, {})
  return {
    id: string(row.id),
    roomId: string(row.room_id),
    identity: string(row.identity),
    displayName: string(row.display_name),
    actorKind: row.actor_kind as RoomParticipant['actorKind'],
    agent: (nullableString(row.agent) as RoomParticipant['agent']) ?? null,
    roleId: nullableString(row.role_id),
    worktreeId: nullableString(row.worktree_id),
    paneKey: nullableString(row.pane_key),
    terminalHandle: nullableString(row.terminal_handle),
    providerSession: parseRoomJson<RoomProviderSession | null>(row.provider_session_json, null),
    processIncarnation: nullableString(row.process_incarnation),
    terminalSurfaceVisible: number(row.terminal_surface_visible) === 1,
    participation: row.participation === 'paused' ? 'paused' : 'active',
    state: row.state as RoomParticipant['state'],
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
    actorKind: row.actor_kind as RoomMessage['actorKind'],
    kind: row.kind as RoomMessage['kind'],
    body: string(row.body),
    replyToId: nullableString(row.reply_to_id),
    rootMessageId: nullableString(row.root_message_id),
    hopCount: number(row.hop_count),
    metadata: parseRoomJson<Record<string, unknown>>(row.metadata_json, {}),
    mentions,
    attachments,
    createdAt: number(row.created_at),
    editedAt: nullableNumber(row.edited_at),
    deletedAt: nullableNumber(row.deleted_at)
  }
}

export function deliveryFromRow(row: RoomRow): RoomDelivery {
  return {
    id: string(row.id),
    messageId: string(row.message_id),
    participantId: string(row.participant_id),
    state: row.state as RoomDelivery['state'],
    attempts: number(row.attempts),
    error: nullableString(row.error),
    nextAttemptAt: number(row.next_attempt_at),
    deliveredAt: nullableNumber(row.delivered_at),
    providerTurnId: nullableString(row.provider_turn_id),
    responseMessageId: nullableString(row.response_message_id),
    respondedAt: nullableNumber(row.responded_at),
    phase: nullableString(row.phase) as RoomDelivery['phase'],
    attemptHistory: parseRoomJson(row.attempt_history_json, [])
  }
}

export function pinFromRow(row: RoomRow): RoomPin {
  return {
    roomId: string(row.room_id),
    messageId: string(row.message_id),
    status: row.status as RoomPin['status'],
    createdBy: string(row.created_by),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at)
  }
}
