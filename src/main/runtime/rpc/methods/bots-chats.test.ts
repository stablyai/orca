import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { MOBILE_RPC_METHOD_ROUTES } from '../server/runtime-rpc-mobile-method-routing'
import { BOT_CHATS_METHODS } from './bots-chats'

describe('retired bot mailbox compatibility', () => {
  it.each(['owner', 'mobile'] as const)(
    'clears cached counts for an older %s client',
    async (kind) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this compatibility call reads only the runtime id for its envelope.
      const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: BOT_CHATS_METHODS,
        callerScope: { kind }
      })

      expect(
        await dispatcher.dispatch({ id: 'req-1', authToken: 'token', method: 'bots.chats.unseen' })
      ).toEqual({
        id: 'req-1',
        ok: true,
        result: { unseen: {} },
        _meta: { runtimeId: 'test-runtime' }
      })
    }
  )

  it('routes older phones to the execution host that owns their cached count', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.get('bots.chats.unseen')).toBe('execution-host')
  })
})
