import * as z from 'zod'
import type { BotGroup, BotGroupMessage } from '../../shared/bots/bot-group'
import {
  BotGroupMessageSchema,
  BotGroupRemoteAskSchema,
  BotGroupRemoteMemberSchema,
  BotGroupSchema
} from '../../shared/bots/bot-group-schema'
import type Database from '../sqlite/sync-database'

// How released builds that predate keeping unknown keys write a group's records: each parses a
// record with its own schema, which strips what it doesn't know, and writes the result back with
// the statements it shipped. Each schema is today's, less what that release didn't have, with the
// agents it knew.

const AGENTS_268 = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'omp',
  'pi',
  'antigravity',
  'cursor',
  'hermes',
  'copilot',
  'opencode2'
] as const
const AGENTS_271 = [
  ...AGENTS_268,
  'kimi',
  'kiro',
  'aug',
  'goose',
  'kilo',
  'mimo-code',
  'gemini',
  'droid',
  'qwen-code'
] as const

const Turn = BotGroupMessageSchema.shape.turns.element
const Message = BotGroupMessageSchema.omit({ sequence: true })

const SCHEMAS = {
  /** v1.4.268: no paired members or their questions, peer answers or hand-off marks. */
  'v1.4.268': {
    group: BotGroupSchema.omit({ remoteMembers: true }),
    message: Message.omit({
      remoteAsks: true,
      handoffs: true,
      mentioned: true,
      pausedAfter: true,
      automationRun: true,
      fromItems: true,
      memorySource: true,
      triggeredBy: true
    }).extend({
      turns: z.array(
        Turn.omit({
          answer: true,
          handedOff: true,
          mailed: true,
          avatarOutfit: true,
          failure: true
        }).extend({ agent: z.enum(AGENTS_268) })
      )
    })
  },
  /** v1.4.271: paired members and their questions, without outfits or failure codes. */
  'v1.4.271': {
    group: BotGroupSchema.extend({
      remoteMembers: z
        .array(
          BotGroupRemoteMemberSchema.omit({ avatarOutfit: true }).extend({
            agent: z.enum(AGENTS_271)
          })
        )
        .optional()
        .catch(undefined)
    }),
    message: Message.omit({ fromItems: true, memorySource: true, triggeredBy: true }).extend({
      turns: z.array(
        Turn.omit({ avatarOutfit: true, failure: true }).extend({ agent: z.enum(AGENTS_271) })
      ),
      remoteAsks: z
        .array(
          BotGroupRemoteAskSchema.omit({ avatarOutfit: true, failure: true }).extend({
            agent: z.enum(AGENTS_271)
          })
        )
        .optional()
        .catch(undefined)
    })
  }
} as const

export type ReleasedBuild = keyof typeof SCHEMAS

/** The store as a released build ran it, on the same database. */
export function releasedStore(db: Database, build: ReleasedBuild) {
  const schema = SCHEMAS[build]
  const read = (table: string, id: string) =>
    JSON.parse(String(db.prepare(`SELECT record FROM ${table} WHERE id = ?`).get(id)!.record))
  return {
    group: (id: string): BotGroup => schema.group.parse(read('bot_groups', id)),
    message: (id: string): Omit<BotGroupMessage, 'sequence'> =>
      schema.message.parse(read('bot_group_messages', id)),
    put(group: BotGroup) {
      // v1.4.270 started writing the paired roster's key always, also when it was cleared.
      const record =
        build === 'v1.4.268' ? group : { ...group, remoteMembers: group.remoteMembers ?? [] }
      db.prepare(
        'INSERT INTO bot_groups(id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record'
      ).run(group.id, JSON.stringify(record))
    },
    update(message: Omit<BotGroupMessage, 'sequence'>) {
      db.prepare('UPDATE bot_group_messages SET record = ? WHERE id = ? AND group_id = ?').run(
        JSON.stringify(message),
        message.id,
        message.groupId
      )
    },
    /** v1.4.268's: it knew no question index. */
    append(message: Omit<BotGroupMessage, 'sequence'>) {
      db.prepare('INSERT INTO bot_group_messages(id, group_id, record) VALUES (?, ?, ?)').run(
        message.id,
        message.groupId,
        JSON.stringify(message)
      )
    },
    /** v1.4.268's: it knew no question index. */
    deleteGroup(groupId: string) {
      const ofGroup = 'SELECT id FROM bot_group_messages WHERE group_id = ?'
      for (const statement of [
        `DELETE FROM bot_group_operations WHERE message_id IN (${ofGroup})`,
        'DELETE FROM bot_group_pending WHERE group_id = ?',
        'DELETE FROM bot_group_messages WHERE group_id = ?',
        'DELETE FROM bot_group_sidebar WHERE group_id = ?',
        'DELETE FROM bot_groups WHERE id = ?'
      ]) {
        db.prepare(statement).run(groupId)
      }
    }
  }
}
