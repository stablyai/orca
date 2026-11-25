import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  normalizeCommandPositionals,
  parseArgs,
  validateCommandAndFlags
} from '../../../../cli/arguments/args'
import { BOT_ITEM_HANDLERS } from '../../../../cli/bots/bot-items'
import type { HandlerContext } from '../../../../cli/dispatch/dispatch'
import type { RuntimeCallOptions } from '../../../../cli/runtime/connection/types'
import { BOT_ITEM_COMMAND_SPECS } from '../../../../cli/specs/bot-items'
import { makeTestBotItem } from '../../../../shared/bots/bot-item.test-fixture'
import { RUNTIME_CAPABILITIES } from '../../../../shared/remote-runtime/protocol/protocol-version'
import { BotItemsStore } from '../../../bots/bot-items-store'
import type { BotItemBotActor } from '../../../bots/bot-items-input'
import type { BotItemRecord } from '../../../bots/bot-items-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../../../native-chat/agent-session-attachments/agent-session-attachment-claims'
import {
  getAgentSessionAttachmentClaimer,
  getAgentSessionAttachmentStore
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import { runJournalTransaction } from '../../../native-chat/agent-session-journal/database/journal-database'
import {
  applyJournalWriterEffect,
  type JournalWriterEffect
} from '../../../native-chat/agent-session-journal/journal-writer-effects'
import SyncDatabase from '../../../sqlite/sync-database'
import {
  installAgentSessionAttachments,
  stopAgentSessionAttachments
} from '../../agent-session/installation/structured-agent-session-attachment-wiring'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import type { RpcContext } from '../core'
import { BOT_ITEMS_WRITE_METHODS } from './bots-items-write-methods'
import type * as WriteSupport from './bots-items-write-support'
import type * as Chats from './bots-chats'

vi.mock('./bots-chats', async (actual) => ({
  ...(await actual<typeof Chats>()),
  botChatTakingMail: async () => ({ sessionId: 'rail-chat', title: 'Rail' })
}))

vi.mock('./bots-items-write-support', async (actual) => ({
  ...(await actual<typeof WriteSupport>()),
  writerOf: (_params: unknown, context: RpcContext) => {
    const chatId = sessionCallerOf(context.orchestrationCaller)?.sessionId
    return {
      actor: { kind: 'bot', botId: 'designer', chatId },
      sessionId: chatId,
      source: { kind: 'chat', title: null }
    }
  }
}))

describe('changing a bot item from an observed version', () => {
  it('preserves progress, history and outgoing mail when another chat submits an old ask', async () => {
    const store = BotItemsStore.open(':memory:')
    try {
      const actor = { kind: 'bot', botId: 'designer', chatId: 'rail-chat' } as const
      const { uid } = store.add(
        {
          ownerBotId: actor.botId,
          chatId: actor.chatId,
          source: { kind: 'chat', title: 'Rail' },
          title: 'Redesign the rail',
          status: 'working',
          links: []
        },
        actor
      )
      store.set(
        uid,
        { status: 'needs_you', comment: 'Which original design should we use?' },
        actor
      )
      const set = BOT_ITEMS_WRITE_METHODS.find((method) => method.name === 'bots.items.set')!
      const runtime = {
        bots: { list: () => [{ id: actor.botId, notifications: { needsPermission: false } }] },
        ensureStructuredAgentSessionHost: async () => {},
        botItems: {
          store: () => ({
            byNumber: (number: number) => store.byNumber(number),
            get: (id: string) => store.get(id),
            events: (...args: Parameters<BotItemsStore['events']>) => store.events(...args),
            set: async (...args: Parameters<BotItemsStore['set']>) => store.set(...args)
          }),
          changed: () => {},
          views: async ([record]: [BotItemRecord]) => [
            makeTestBotItem(record.number, { status: record.status, version: record.version })
          ],
          sendOwedMail: async () => {}
        }
      }
      const run = async (
        chatId: string,
        args: string[],
        capabilities: readonly string[] = RUNTIME_CAPABILITIES
      ) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime fields and the authenticated chat ID.
        const context = {
          runtime,
          orchestrationCaller: { sessionId: chatId }
        } as unknown as RpcContext
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this command uses only call; local transport is replaced by the two real contracts.
        const client = {
          call: async (method: string, params: unknown, options?: RuntimeCallOptions) => {
            expect(method).toBe('bots.items.set')
            const request = options?.requestSelection
              ? options.requestSelection.paramsForStatus({ capabilities })
              : params
            return { result: await set.handler(set.params.parse(request), context) }
          }
        } as unknown as HandlerContext['client']
        const parsed = normalizeCommandPositionals(
          BOT_ITEM_COMMAND_SPECS,
          parseArgs(
            ['bot', 'item', 'set', '1', ...args],
            [['bot', 'item', 'set']],
            BOT_ITEM_COMMAND_SPECS
          )
        )
        validateCommandAndFlags(BOT_ITEM_COMMAND_SPECS, parsed)
        await BOT_ITEM_HANDLERS['bot item set']!({
          flags: parsed.flags,
          client,
          cwd: '.',
          json: false,
          rawArgs: args
        })
      }

      await run(actor.chatId, [
        '--expected-version',
        '3',
        '--status',
        'in-progress',
        '--comment',
        'Research is ready'
      ])
      const progress = store.get(uid)
      const events = store.events(uid, 0, 100)
      const mail = store.owedMail(0)
      expect(progress).toMatchObject({ status: 'working', version: 5, questionEvent: null })
      const stale = [
        '--expected-version',
        '3',
        '--status',
        'needs-you',
        '--ask',
        'Use an original design?'
      ]
      await expect(run('pr-chat', stale)).rejects.toMatchObject({ code: 'item_changed' })
      await expect(run('pr-chat', stale, [])).rejects.toMatchObject({
        code: 'incompatible_runtime'
      })
      expect(store.get(uid)).toEqual(progress)
      expect(store.events(uid, 0, 100)).toEqual(events)
      expect(store.owedMail(0)).toEqual(mail)

      await run('home-chat', ['--status', 'needs-you', '--ask', 'Review the revised design?'])
      expect(store.get(uid)).toMatchObject({ status: 'needs_you', version: 7 })
      expect(store.owedMail(0).mails).toEqual([expect.objectContaining({ chatId: actor.chatId })])
      await verifyAttachmentConflict(run, store, uid, actor)
    } finally {
      store.dispose()
    }
  })
})

async function verifyAttachmentConflict(
  run: (chatId: string, args: string[]) => Promise<void>,
  items: BotItemsStore,
  uid: string,
  actor: BotItemBotActor
): Promise<void> {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'orca-bot-item-version-'))
  const journal = new SyncDatabase(':memory:')
  try {
    ensureAgentSessionAttachmentClaimTables(journal)
    let afterClaim: (() => void) | undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attachment wiring uses the writer effect entry point and these two state flags.
    const journalDatabase = {
      readOnly: false,
      isClosed: false,
      effects: async (effects: readonly JournalWriterEffect[]) => {
        const results = runJournalTransaction(journal, () =>
          effects.map((effect) => applyJournalWriterEffect(journal, stateDirectory, effect))
        )
        if (afterClaim && effects.some((effect) => effect.kind === 'claim')) {
          afterClaim()
        }
        return results
      }
    } as unknown as JournalSqlDatabase
    installAgentSessionAttachments({
      stateDirectory,
      journalDatabase,
      store: { getRecord: () => null, isSessionUnreadable: () => false },
      logger: { warn: () => {}, error: () => {} }
    })
    const attachments = getAgentSessionAttachmentStore()!
    const kept = await attachments.storeFile('kept.txt', Buffer.from('Earlier published file'))
    const keptId = basename(dirname(kept))
    await getAgentSessionAttachmentClaimer()!(actor.chatId, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: `@${kept}` }]
    })
    const fresh = join(stateDirectory, 'fresh.txt')
    await writeFile(fresh, 'Unpublished revision')
    afterClaim = () => {
      items.set(uid, { status: 'working', comment: 'Continue the current design' }, actor)
    }
    await expect(
      run('pr-chat', [
        '--expected-version',
        '7',
        '--status',
        'needs-you',
        '--ask',
        'Reopen the old design?',
        '--file',
        kept,
        '--file',
        fresh
      ])
    ).rejects.toMatchObject({ code: 'item_changed' })

    expect(items.get(uid)).toMatchObject({ status: 'working', version: 9, questionEvent: null })
    expect(await readdir(attachments.rootDir)).toEqual([keptId])
    expect(journal.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()).toEqual([
      { upload_id: keptId }
    ])

    afterClaim = undefined
    await run(actor.chatId, [
      '--expected-version',
      '9',
      '--status',
      'needs-you',
      '--ask',
      'Review the current design?',
      '--file',
      fresh
    ])
    expect(items.get(uid)).toMatchObject({ status: 'needs_you', version: 11 })
    expect(await readdir(attachments.rootDir)).toHaveLength(2)
    expect(
      journal.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
    ).toHaveLength(2)
  } finally {
    stopAgentSessionAttachments()
    journal.close()
    await rm(stateDirectory, { recursive: true, force: true })
  }
}
