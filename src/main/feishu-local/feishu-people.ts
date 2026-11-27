import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { z } from 'zod'
import { feishuCommand } from './feishu-cli'

const page = lazyZodSchema(() =>
  z.object({
    ok: z.literal(true),
    identity: z.literal('bot'),
    data: z.object({
      items: z.array(z.unknown()).default([]),
      has_more: z.boolean().default(false),
      page_token: z.string().optional(),
      trigger_security_conf_limit: z.boolean().optional()
    })
  })
)
const person = lazyZodSchema(() =>
  z.object({
    member_id: z.string().regex(/^ou_[a-zA-Z0-9_-]+$/),
    member_id_type: z.literal('open_id'),
    name: z.string().trim().min(1).max(200),
    is_agent: z.boolean().optional()
  })
)
export type FeishuPeople = { members: { id: string; name: string }[]; complete: boolean }

/** Only the bot's own group membership, never the owner's user-token address book. */
export async function feishuPeople(app: string, signal: AbortSignal): Promise<FeishuPeople> {
  let complete = true
  const read = async (path: string, params: Record<string, unknown>) => {
    const items: unknown[] = []
    let token: string | undefined
    for (let i = 0; i < 10; i++) {
      const { data } = page.parse(
        await feishuCommand(
          [
            '--profile',
            app,
            'api',
            'GET',
            path,
            '--as',
            'bot',
            '--params',
            JSON.stringify({ ...params, page_size: 100, ...(token ? { page_token: token } : {}) })
          ],
          signal
        )
      )
      items.push(...data.items)
      if (data.trigger_security_conf_limit) {
        complete = false
      }
      if (!data.has_more) {
        return items
      }
      if (!data.page_token || data.page_token === token) {
        break
      }
      token = data.page_token
    }
    complete = false
    return items
  }
  const chats = await read('/open-apis/im/v1/chats', {})
  const people = new Map<string, { id: string; name: string }>()
  for (const raw of chats.slice(0, 100)) {
    const chat = z.object({ chat_id: z.string().regex(/^oc_[a-zA-Z0-9_-]+$/) }).parse(raw)
    try {
      for (const entry of await read(`/open-apis/im/v1/chats/${chat.chat_id}/members`, {
        member_id_type: 'open_id'
      })) {
        const p = person.safeParse(entry).data
        if (p && !p.is_agent) {
          people.set(p.member_id, { id: p.member_id, name: p.name })
        }
      }
    } catch {
      signal.throwIfAborted()
      complete = false
    }
  }
  return { members: [...people.values()], complete: complete && chats.length <= 100 }
}

export class FeishuPeopleDirectory {
  private cached?: { app: string; at: number; result: Promise<FeishuPeople> }
  async search(app: string, query: string, signal: AbortSignal) {
    if (!this.cached || this.cached.app !== app || Date.now() - this.cached.at > 60_000) {
      const result = feishuPeople(app, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
      this.cached = { app, at: Date.now(), result }
      void result.catch(() => {
        if (this.cached?.result === result) {
          this.cached = undefined
        }
      })
    }
    const result = await this.cached.result
    const needle = query.trim().toLocaleLowerCase()
    return {
      ...result,
      members: result.members.filter((p) =>
        `${p.name} ${p.id}`.toLocaleLowerCase().includes(needle)
      )
    }
  }
}
