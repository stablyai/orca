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
    ['connector.watch', { forMs: 0 }]
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
})
