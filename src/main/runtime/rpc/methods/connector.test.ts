import { describe, expect, it } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../core'
import { CONNECTOR_METHODS } from './connector'

const methods = eraseRpcMethods(CONNECTOR_METHODS)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: disabled handlers must refuse at this gate before reading any other runtime service.
const context = { runtime: { getExternalConversationSeam: () => null } } as RpcContext

describe('connector RPC methods', () => {
  it.each([
    [
      'connector.start',
      {
        source: 'slack',
        externalId: 'thread-1',
        deliveryId: 'delivery-1',
        agent: 'codex',
        target: { kind: 'existing', worktree: 'workspace-1' },
        prompt: 'Help with this thread'
      }
    ],
    [
      'connector.send',
      { source: 'slack', externalId: 'thread-1', deliveryId: 'delivery-1', text: 'Follow up' }
    ],
    ['connector.pendingPrompt', { source: 'slack', externalId: 'thread-1' }],
    [
      'connector.answer',
      { source: 'slack', externalId: 'thread-1', promptId: 'prompt-1', optionId: 'option-1' }
    ],
    ['connector.cancel', { source: 'slack', externalId: 'thread-1', deliveryId: 'delivery-1' }],
    ['connector.watch', { forMs: 0 }],
    ['connector.reply', { paneKey: 'tab:1', replyId: 'r1', text: 'done' }]
  ] as const)('%s refuses requests while the host has connectors off', async (name, input) => {
    const method = methods.find((candidate) => candidate.name === name)
    if (!method?.params) {
      throw new Error(`Missing connector method: ${name}`)
    }
    const params = method.params.parse(input)

    await expect(Promise.resolve().then(() => method.handler(params, context))).rejects.toThrow(
      new Error('connectors_disabled')
    )
  })

  describe('connector.reply', () => {
    const reply = methods.find((candidate) => candidate.name === 'connector.reply')!
    const input = { paneKey: 'tab:1', replyId: 'r1', text: 'done' }
    function replyContext(
      target: { key: { source: string; externalId: string }; turnId: number | null } | null,
      sent: unknown
    ): RpcContext {
      const runtime = {
        getExternalConversationSeam: () => ({ replyTarget: () => target }),
        getConnectorCloud: () => (sent === undefined ? null : { reply: async () => sent })
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.reply reads only these two runtime services.
      return { runtime } as unknown as RpcContext
    }
    const slack = { key: { source: 'slack', externalId: 'T1:C9:1:U5' }, turnId: 7 }

    it('posts to the pane’s Slack conversation and turn', async () => {
      const posted = { status: 'posted', messageId: '1793.1' }
      await expect(
        reply.handler(reply.params!.parse(input), replyContext(slack, { ok: true, value: posted }))
      ).resolves.toEqual(posted)
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
