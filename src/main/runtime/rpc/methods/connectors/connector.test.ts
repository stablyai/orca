import { describe, expect, it, vi } from 'vitest'
import { chatPaneKey } from '../../../../external-conversations/external-conversation-chat'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { CONNECTOR_METHODS } from './connector'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'

// Whom the chat's turn acts for, as Orca's own record of that turn says (bot-turn-for.ts).
vi.mock('../../../../bots/bot-turn-for', () => ({ botTurnFor: async () => 'owner' }))

const methods = eraseRpcMethods(CONNECTOR_METHODS)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: disabled handlers must refuse at this gate before reading any other runtime service.
const context = { runtime: { getExternalConversationSeam: () => null } } as RpcContext

describe('connector RPC methods', () => {
  it('refuses a reply while the host has connectors off', async () => {
    const method = methods.find((candidate) => candidate.name === 'connector.reply')!
    const params = method.params!.parse({ paneKey: 'tab:1', replyId: 'r1', text: 'done' })

    await expect(Promise.resolve().then(() => method.handler(params, context))).rejects.toThrow(
      new Error('connectors_disabled')
    )
  })

  describe('connector.reply', () => {
    const reply = methods.find((candidate) => candidate.name === 'connector.reply')!
    const input = { paneKey: 'tab:1', replyId: 'r1', text: 'done' }
    const asked: string[] = []
    const posted: unknown[] = []
    const scout = { id: 'b1', folderWorkspaceId: 'fw-scout' }
    function replyContext(
      target: {
        key: { source: string; externalId: string }
        turnId: number | null
        worktreeId?: string
        bot?: { kind: 'bot' | 'bot-chat'; botId: string }
      } | null,
      sent: unknown,
      bots: { enabled: boolean; list: readonly { id: string; folderWorkspaceId: string }[] } = {
        enabled: true,
        list: [scout]
      }
    ): RpcContext {
      const runtime = {
        getExternalConversationSeam: () => ({
          replyTarget: (paneKey: string) => {
            asked.push(paneKey)
            return target
          }
        }),
        getConnectorCloud: () =>
          sent === undefined
            ? null
            : {
                reply: async (body: unknown) => {
                  posted.push(body)
                  return sent
                }
              },
        bots: { enabled: () => bots.enabled, list: () => bots.list }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.reply reads only these three runtime services.
      return { runtime } as unknown as RpcContext
    }
    const slack = {
      key: { source: 'slack', externalId: 'T1:C9:1:U5' },
      turnId: 7,
      worktreeId: 'wt-1'
    }
    const botThread = {
      ...slack,
      worktreeId: folderWorkspaceKey('fw-scout'),
      bot: { kind: 'bot', botId: 'b1' }
    } as const

    it('passes a review on with the reply', async () => {
      const review = { comments: [{ path: 'src/a.ts', line: 3, body: 'Off by one.' }] }
      await reply.handler(
        reply.params!.parse({ ...input, review }),
        replyContext(slack, { ok: true, value: { status: 'posted', messageId: '1793.3' } })
      )
      expect(posted.at(-1)).toEqual(expect.objectContaining({ text: 'done', review }))
    })

    it('resolves a native chat’s reply by its session id', async () => {
      const posted = { status: 'posted', messageId: '1793.2' }
      const chat = { sessionId: 'session-1', replyId: 'r2', text: 'done' }
      await expect(
        reply.handler(reply.params!.parse(chat), replyContext(slack, { ok: true, value: posted }))
      ).resolves.toEqual(posted)
      expect(asked.at(-1)).toBe(chatPaneKey('session-1'))
    })

    it('posts a bot thread’s chat into its own conversation, as that bot, for whom its turn acts', async () => {
      posted.length = 0
      const ok = { status: 'queued' }
      const chat = { sessionId: 'session-1', replyId: 'r3', text: 'Started a worker' }
      await expect(
        reply.handler(reply.params!.parse(chat), replyContext(botThread, { ok: true, value: ok }))
      ).resolves.toEqual(ok)
      expect(posted).toEqual([
        {
          replyId: 'r3',
          conversation: { source: 'slack', externalId: 'T1:C9:1:U5' },
          turnId: 7,
          text: 'Started a worker',
          turnFor: 'owner'
        }
      ])
    })

    it.each([
      [
        'bot_chat_reply',
        'the bot’s Chat',
        { ...botThread, bot: { kind: 'bot-chat', botId: 'b1' } },
        undefined
      ],
      [
        'not_this_bots_conversation',
        'a chat outside the bot’s home',
        { ...botThread, worktreeId: 'wt-other' },
        undefined
      ],
      [
        'not_this_bots_conversation',
        'a bot that is gone',
        { ...botThread, bot: { kind: 'bot', botId: 'b9' } },
        undefined
      ],
      [
        'not_this_bots_conversation',
        'bots turned off',
        botThread,
        { enabled: false, list: [scout] }
      ]
    ] as const)('refuses with %s for %s and posts nothing', async (code, _, target, bots) => {
      posted.length = 0
      await expect(
        reply.handler(
          reply.params!.parse({ sessionId: 'session-1', replyId: 'r4', text: 'hi' }),
          replyContext(target, { ok: true, value: { status: 'queued' } }, bots)
        )
      ).rejects.toThrow(new Error(code))
      expect(posted).toEqual([])
    })

    it.each([
      ['not_a_cloud_conversation', null, { ok: true }],
      ['not_a_cloud_conversation', { ...slack, key: { source: 'dev', externalId: 'x' } }, {}],
      ['no_current_turn', { ...slack, turnId: null }, {}],
      ['connector_not_connected', slack, undefined],
      ['not_this_hosts_thread', slack, { ok: false, status: 403, error: 'not_this_hosts_thread' }],
      ['connector_unavailable', slack, { ok: false, status: 503, error: null }]
    ] as const)('refuses with %s', async (code, target, sent) => {
      await expect(
        reply.handler(reply.params!.parse(input), replyContext(target, sent))
      ).rejects.toThrow(new Error(code))
    })
  })
})
