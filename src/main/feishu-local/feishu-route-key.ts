import { z } from 'zod'
import { createHash } from 'node:crypto'
import { dmKey, type Binding } from './feishu-binding'
export const feishuRoute = z.object({
  external: z.string(),
  chat: z.string(),
  root: z.string(),
  original: z.string(),
  group: z.boolean()
})
export type FeishuRoute = z.infer<typeof feishuRoute>
export function threadKey(b: Binding, chat: string, root: string) {
  return {
    source: 'feishu-local' as const,
    externalId: createHash('sha256')
      .update(JSON.stringify([dmKey(b).externalId, chat, root]))
      .digest('hex')
  }
}
