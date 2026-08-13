import { z } from 'zod'
import { ROOM_HARNESS_AGENTS } from '../../../../shared/rooms'

export const RoomId = z.string().uuid()
export const ParticipantId = z.string().uuid()
export const MessageId = z.string().uuid()
export const ReaderKey = z.string().trim().min(1).max(120).default('user')
export const RoomIdentity = z.string().trim().min(1).max(80)

const ExistingParticipantConnection = z
  .object({
    kind: z.literal('existing'),
    worktreeId: z.string().min(1).max(32_768),
    terminalHandle: z.string().min(1).max(128).optional(),
    paneKey: z.string().min(1).max(512).optional(),
    historyId: z.string().trim().min(1).max(32_768).optional()
  })
  .strict()
  .superRefine((connection, context) => {
    const hasTerminal = Boolean(connection.terminalHandle && connection.paneKey)
    if (!hasTerminal && !connection.historyId) {
      context.addIssue({ code: 'custom', message: 'Existing session identity is required.' })
    }
    if (Boolean(connection.terminalHandle) !== Boolean(connection.paneKey)) {
      context.addIssue({ code: 'custom', message: 'Terminal handle and pane key must be paired.' })
    }
  })

export const ParticipantConnection = z.union([
  z.object({ kind: z.literal('new'), worktreeId: z.string().min(1).max(32_768) }).strict(),
  ExistingParticipantConnection
])

export const HarnessAgent = z.enum(ROOM_HARNESS_AGENTS)

export const RoomSubscription = z
  .object({
    roomId: RoomId,
    readerKey: ReaderKey,
    subscriptionId: z.string().trim().min(1).max(256)
  })
  .strict()
