import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiVaultSessionTitlesParams } from '../../../shared/rpc-contract/ai-vault/ai-vault-params'

const { callRuntimeEnvironment } = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn()
}))

vi.mock('../../ipc/runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment
}))

import { resolveRuntimeAiVaultSessionTitles } from './runtime-session-scanner'

beforeEach(() => {
  callRuntimeEnvironment.mockReset()
})

describe('resolveRuntimeAiVaultSessionTitles', () => {
  it('retries without antigravity when an older runtime host rejects mixed requests', async () => {
    const requestedBatches: { agent: string; sessionId: string }[][] = []
    callRuntimeEnvironment.mockImplementation(
      async (_userDataPath: string, _environmentId: string, _method: string, params: unknown) => {
        const requests = AiVaultSessionTitlesParams.parse(params).requests.map(
          ({ agent, sessionId }) => ({ agent, sessionId })
        )
        requestedBatches.push(requests)
        if (requests.some((request) => request.agent === 'antigravity')) {
          return {
            id: 'req-1',
            ok: false,
            error: { code: 'invalid_argument', message: 'Invalid option' }
          }
        }
        return {
          id: 'req-2',
          ok: true,
          result: {
            titles: [
              {
                agent: 'codex',
                sessionId: 'codex-1',
                title: 'Fix login redirect',
                kind: 'named'
              }
            ]
          },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
    )

    const result = await resolveRuntimeAiVaultSessionTitles('/tmp/user-data', 'env-1', {
      requests: [
        { agent: 'codex', sessionId: 'codex-1' },
        { agent: 'antigravity', sessionId: 'agy-1' }
      ]
    })

    expect(result).toEqual({
      titles: [
        {
          agent: 'codex',
          sessionId: 'codex-1',
          title: 'Fix login redirect',
          kind: 'named'
        }
      ]
    })
    expect(requestedBatches).toEqual([
      [
        { agent: 'codex', sessionId: 'codex-1' },
        { agent: 'antigravity', sessionId: 'agy-1' }
      ],
      [{ agent: 'codex', sessionId: 'codex-1' }]
    ])
  })

  it('returns empty titles without sending an empty retry for antigravity-only batches', async () => {
    const requestedBatches: { agent: string; sessionId: string }[][] = []
    callRuntimeEnvironment.mockImplementation(
      async (_userDataPath: string, _environmentId: string, _method: string, params: unknown) => {
        const requests = AiVaultSessionTitlesParams.parse(params).requests.map(
          ({ agent, sessionId }) => ({ agent, sessionId })
        )
        requestedBatches.push(requests)
        return {
          id: 'req-1',
          ok: false,
          error: { code: 'invalid_argument', message: 'Invalid option' }
        }
      }
    )

    const result = await resolveRuntimeAiVaultSessionTitles('/tmp/user-data', 'env-1', {
      requests: [{ agent: 'antigravity', sessionId: 'agy-1' }]
    })

    expect(result).toEqual({ titles: [] })
    expect(requestedBatches).toEqual([[{ agent: 'antigravity', sessionId: 'agy-1' }]])
  })
})
