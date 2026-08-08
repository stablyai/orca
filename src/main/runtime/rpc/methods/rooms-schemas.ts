import { z } from 'zod'
import { ROOM_HARNESS_AGENTS } from '../../../../shared/rooms'

export const RoomId = z.string().uuid()
export const ParticipantId = z.string().uuid()
export const MessageId = z.string().uuid()
export const ReaderKey = z.string().trim().min(1).max(120).default('user')
export const RoomIdentity = z.string().trim().min(1).max(80)

export const ParticipantConnection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('launch'), worktreeId: z.string().min(1).max(32_768) }).strict(),
  z
    .object({
      kind: z.literal('attach'),
      worktreeId: z.string().min(1).max(32_768),
      terminalHandle: z.string().min(1).max(128),
      paneKey: z.string().min(1).max(512)
    })
    .strict(),
  z
    .object({
      kind: z.literal('resume'),
      worktreeId: z.string().min(1).max(32_768),
      historyId: z.string().trim().min(1).max(32_768)
    })
    .strict()
])

export const HarnessAgent = z.enum(ROOM_HARNESS_AGENTS)

export const RoomSubscription = z
  .object({
    roomId: RoomId,
    readerKey: ReaderKey,
    subscriptionId: z.string().trim().min(1).max(256)
  })
  .strict()
