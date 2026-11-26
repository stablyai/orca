// The parts of Microsoft Graph's Teams answers Orca reads; anything else Graph sends is dropped.
import { z } from 'zod'

const Name = z.string().nullish()
const page = <T extends z.ZodType>(item: T) =>
  z.object({ value: z.array(item).optional(), '@odata.nextLink': z.string().optional() })
export const GraphChat = z.object({
  id: z.string(),
  topic: Name,
  chatType: Name,
  members: z.array(z.object({ displayName: Name, userId: Name })).optional(),
  lastMessagePreview: z.object({ createdDateTime: Name }).nullish()
})
export const GraphNamed = z.object({ id: z.string(), displayName: Name })
export const GraphMessage = z.object({
  id: z.string(),
  messageType: Name,
  createdDateTime: Name,
  lastModifiedDateTime: Name,
  deletedDateTime: Name,
  from: z
    .object({
      user: z.object({ id: Name, displayName: Name }).nullish(),
      application: z.object({ displayName: Name }).nullish()
    })
    .nullish(),
  body: z.object({ contentType: Name, content: Name }).nullish(),
  attachments: z.array(z.object({ contentType: Name, name: Name })).nullish(),
  mentions: z
    .array(z.object({ mentioned: z.object({ user: z.object({ id: Name }).nullish() }).nullish() }))
    .nullish(),
  webUrl: Name
})
export type GraphChat = z.infer<typeof GraphChat>
export type GraphTeam = z.infer<typeof GraphNamed>
export type GraphChannel = z.infer<typeof GraphNamed>
export type GraphMessage = z.infer<typeof GraphMessage>
export const ChatPage = page(GraphChat)
export const NamedPage = page(GraphNamed)
export const MessagePage = page(GraphMessage)
