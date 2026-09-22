import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

const request = (params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'settings.mutateNativeChatSessionOptions',
  params
})

describe('native-chat settings RPC', () => {
  it('routes option deltas to the runtime-owned atomic update', async () => {
    const updateClientNativeChatSessionOptions = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientNativeChatSessionOptions
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
    const mutation = {
      type: 'apply-picks' as const,
      agent: 'codex' as const,
      picks: [
        { modelId: 'gpt-fast', optionId: 'model' as const, value: 'gpt-fast' },
        { modelId: 'gpt-fast', optionId: 'effort' as const, value: 'low' }
      ]
    }

    const response = await dispatcher.dispatch(request(mutation))

    expect(updateClientNativeChatSessionOptions).toHaveBeenCalledExactlyOnceWith(mutation)
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('rejects malformed option deltas', async () => {
    const updateClientNativeChatSessionOptions = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientNativeChatSessionOptions
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    for (const mutation of [
      { type: 'apply-picks', agent: 'codex', picks: [] },
      {
        type: 'apply-picks',
        agent: 'opencode',
        picks: [{ modelId: 'model', optionId: 'model', value: 'model' }]
      },
      {
        type: 'apply-picks',
        agent: 'codex',
        picks: [{ modelId: 'model', optionId: 'arbitrary', value: 'value' }]
      },
      {
        type: 'apply-picks',
        agent: 'codex',
        picks: [{ modelId: 'model', optionId: 'effort', value: true }]
      },
      {
        type: 'apply-picks',
        agent: 'cursor',
        picks: [{ modelId: 'model', optionId: 'fastMode', value: 'true' }]
      },
      {
        type: 'clear-model-if-missing',
        agent: 'grok',
        availableModelIds: []
      }
    ]) {
      const response = await dispatcher.dispatch(request(mutation))
      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    expect(updateClientNativeChatSessionOptions).not.toHaveBeenCalled()
  })
})
