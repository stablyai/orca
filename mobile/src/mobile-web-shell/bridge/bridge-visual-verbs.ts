import * as z from 'zod'
import { isNativeChatVisualFileName } from '../../../../src/shared/native-chat/native-chat-visual-directive'

export const BRIDGE_VISUAL_DOCUMENT_VERB = 'native.visual.document'

export const visualDocumentOpenSchema = z.strictObject({
  action: z.literal('open'),
  sessionId: z.string().min(1).max(512),
  file: z.string().refine(isNativeChatVisualFileName),
  executionHost: z.templateLiteral(['runtime:', z.string().min(1)]).optional()
})

export const visualDocumentParamsSchema = z.discriminatedUnion('action', [
  visualDocumentOpenSchema,
  z.strictObject({ action: z.literal('release'), url: z.string().min(1).max(1024) })
])

export const visualDocumentResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ready'),
    url: z.string().min(1).max(1024),
    channel: z.string().min(1).max(128)
  }),
  z.strictObject({ kind: z.literal('released') })
])

export type BridgeVisualOpen = Omit<z.infer<typeof visualDocumentOpenSchema>, 'action'>
