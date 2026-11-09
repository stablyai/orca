import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcRequest } from '../../../core'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import '../../../../../linear/linear-issue-write-support'
import {
  linearError,
  sanitizeLinearErrorMessage,
  type LinearAgentAccessError
} from '../../../../../linear/issue-context/errors'
import { LINEAR_AGENT_ACCESS_METHODS } from './linear-agent-access'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('Linear agent access RPC methods', () => {
  it('rejects workspace all for direct write RPC calls', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearIssueSetState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_ACCESS_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('linear.issueSetState', {
        input: 'ENG-1',
        to: 'In Review',
        workspaceId: 'all'
      })
    )

    expect(response.ok).toBe(false)
    expect(response.ok === false ? response.error.message : '').toContain(
      '--workspace all is not valid for Linear writes'
    )
    expect(runtime.linearIssueSetState).not.toHaveBeenCalled()
  })
})

function runWrite(
  runtime: OrcaRuntimeService,
  write: (signal: AbortSignal) => Promise<unknown>,
  unconfirmed: (cause?: string) => LinearAgentAccessError
): Promise<unknown> {
  return runtime
    .runLinearAgentAction(
      async () => null,
      async (_owner, options) => {
        options.beforeInvoke()
        return write(options.signal)
      },
      (_owner, cause) => unconfirmed(cause)
    )
    .then(({ result }) => result)
}

describe('Linear agent write recovery helpers', () => {
  it('sanitizes Linear provider messages before they enter RPC error envelopes', () => {
    const message = sanitizeLinearErrorMessage(
      'Linear rejected mutation variables: {"body":"user comment payload","id":"issue-1"} headers: {Authorization: Bearer token-123}\n    at handler (linear.ts:1:1)'
    )

    expect(message).toContain('Linear rejected mutation')
    expect(message).toContain('variables: [REDACTED]')
    expect(message).toContain('headers: [REDACTED]')
    expect(message).not.toContain('user comment payload')
    expect(message).not.toContain('token-123')
    expect(message).not.toContain('at handler')
  })

  it('returns unconfirmed at the write deadline even when the request ignores abort', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn((_signal: AbortSignal) => new Promise<string>(() => undefined))
      const unconfirmed = vi.fn(() => linearError('linear_write_unconfirmed', 'unconfirmed'))

      const pending = runWrite(runtime, write, unconfirmed)
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'linear_write_unconfirmed'
      })
      await vi.advanceTimersByTimeAsync(25_000)

      await rejection
      expect(unconfirmed).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0]?.[0].aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
