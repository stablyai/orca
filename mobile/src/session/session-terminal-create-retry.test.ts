import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  sendSessionTerminalCreateResilient,
  supportsSessionTerminalCreateCutoverRetry
} from './session-terminal-create-retry'

type Attempt = { method: string; params: Record<string, unknown> }

// A client whose per-call outcome is scripted: resolve with a tab or throw
// (transport-level rejection, e.g. a connection-migration cutover). Records
// every call so tests can assert the replay reuses the same clientMutationId.
function scriptedClient(
  outcomes: Array<{ tabId: string } | { throws: unknown }>,
  attempts: Attempt[]
): RpcClient {
  let call = 0
  return {
    sendRequest: async (method: string, params?: unknown) => {
      attempts.push({ method, params: (params ?? {}) as Record<string, unknown> })
      const outcome = outcomes[Math.min(call, outcomes.length - 1)]!
      call += 1
      if ('throws' in outcome) {
        throw outcome.throws
      }
      return {
        id: '1',
        ok: true,
        result: { tab: { id: outcome.tabId } },
        _meta: { runtimeId: 'r' }
      }
    }
  } as unknown as RpcClient
}

const params = { worktree: 'id:w', clientMutationId: 'mobile-create:key', agent: 'codex' }

describe('sendSessionTerminalCreateResilient', () => {
  it('requires the explicit disconnect-safe idempotency capability', () => {
    expect(supportsSessionTerminalCreateCutoverRetry(undefined)).toBe(false)
    expect(supportsSessionTerminalCreateCutoverRetry(['terminal.quick-commands.v1'])).toBe(false)
    expect(
      supportsSessionTerminalCreateCutoverRetry(['session.tabs.create-terminal-idempotency.v1'])
    ).toBe(true)
  })

  it('replays the same params after a connection-migration cutover', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ throws: new LogicalClientCutoverError() }, { tabId: 'tab-1' }],
      attempts
    )

    const response = await sendSessionTerminalCreateResilient(client, params, {
      supportsIdempotentCutoverRetry: true
    })

    expect(response.ok).toBe(true)
    expect(attempts).toHaveLength(2)
    expect(attempts.every((attempt) => attempt.method === 'session.tabs.createTerminal')).toBe(true)
    // The replay must reuse the SAME mutation id so the host dedupes it.
    expect(attempts[1]!.params.clientMutationId).toBe('mobile-create:key')
  })

  it('matches cutover errors rethrown as plain Errors', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ throws: new Error('RPC interrupted by connection migration') }, { tabId: 'tab-1' }],
      attempts
    )

    const response = await sendSessionTerminalCreateResilient(client, params, {
      supportsIdempotentCutoverRetry: true
    })

    expect(response.ok).toBe(true)
    expect(attempts).toHaveLength(2)
  })

  it('does not replay against hosts without the mutation-id dedupe', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ throws: new LogicalClientCutoverError() }, { tabId: 'tab-1' }],
      attempts
    )

    await expect(
      sendSessionTerminalCreateResilient(client, params, {
        supportsIdempotentCutoverRetry: false
      })
    ).rejects.toThrow('RPC interrupted by connection migration')
    expect(attempts).toHaveLength(1)
  })

  it('propagates non-cutover transport errors without replaying', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ throws: new Error('relay RPC timed out: session.tabs.createTerminal') }],
      attempts
    )

    await expect(
      sendSessionTerminalCreateResilient(client, params, {
        supportsIdempotentCutoverRetry: true
      })
    ).rejects.toThrow('relay RPC timed out')
    expect(attempts).toHaveLength(1)
  })

  it('gives up after the bounded replay budget instead of looping forever', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new LogicalClientCutoverError() }], attempts)

    await expect(
      sendSessionTerminalCreateResilient(client, params, {
        supportsIdempotentCutoverRetry: true
      })
    ).rejects.toThrow('RPC interrupted by connection migration')
    // 1 initial attempt + 5 replays.
    expect(attempts).toHaveLength(6)
  })
})
