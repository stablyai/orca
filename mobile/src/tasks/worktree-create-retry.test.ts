import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { createWorktreeWithNameRetry } from './worktree-create-retry'

type Attempt = { method: string; params: Record<string, unknown> }

// A client whose per-call outcome is scripted: return an id, a server error
// message, or throw (transport-level rejection, e.g. a connection-migration
// cutover). Records every call so tests can assert on the clientMutationId.
function scriptedClient(
  outcomes: Array<{ id: string } | { errorMessage: string } | { throws: unknown }>,
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
      if ('errorMessage' in outcome) {
        return {
          id: '1',
          ok: false,
          error: { code: 'x', message: outcome.errorMessage },
          _meta: { runtimeId: 'r' }
        }
      }
      return {
        id: '1',
        ok: true,
        result: { worktree: { id: outcome.id } },
        _meta: { runtimeId: 'r' }
      }
    }
  } as unknown as RpcClient
}

describe('createWorktreeWithNameRetry', () => {
  it('waits for capability detection before sending a create', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ id: 'wt-ready' }], attempts)
    let resolveSupport!: (supported: boolean) => void
    const support = new Promise<boolean>((resolve) => {
      resolveSupport = resolve
    })
    const pending = createWorktreeWithNameRetry({
      client,
      baseName: 'puffin',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: support,
      mintMutationId: () => 'key-ready'
    })

    await Promise.resolve()
    expect(attempts).toHaveLength(0)
    resolveSupport(true)

    await expect(pending).resolves.toEqual({ worktreeId: 'wt-ready', name: 'puffin' })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params.clientMutationId).toBe('key-ready')
  })

  it('stamps a clientMutationId on the create request', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ id: 'wt-1' }], attempts)
    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'otter',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: true,
      mintMutationId: () => 'key-1'
    })
    expect(result).toEqual({ worktreeId: 'wt-1', name: 'otter' })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params).toMatchObject({ name: 'otter', clientMutationId: 'key-1' })
  })

  it('retries a connection-migration cutover with the SAME key, then succeeds', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ throws: new LogicalClientCutoverError() }, { id: 'wt-2' }],
      attempts
    )
    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'seal',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: true,
      mintMutationId: () => 'key-mig'
    })
    expect(result).toEqual({ worktreeId: 'wt-2', name: 'seal' })
    expect(attempts).toHaveLength(2)
    // Idempotency: both the interrupted send and the retry carry one key so the
    // host dedupes instead of creating a duplicate worktree.
    expect(attempts[0]!.params.clientMutationId).toBe('key-mig')
    expect(attempts[1]!.params.clientMutationId).toBe('key-mig')
    expect(attempts[1]!.params.name).toBe('seal')
  })

  it('gives up after the cutover retry budget and rethrows', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new LogicalClientCutoverError() }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'crab',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-x'
      })
    ).rejects.toBeInstanceOf(LogicalClientCutoverError)
    // Initial attempt + 5 retries.
    expect(attempts).toHaveLength(6)
  })

  it('does not treat an ordinary transport error as a cutover', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new Error('Request timed out') }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'eel',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-t'
      })
    ).rejects.toThrow('Request timed out')
    expect(attempts).toHaveLength(1)
  })

  it('mints a fresh key per candidate when a name collision bumps the suffix', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ errorMessage: 'already exists locally' }, { id: 'wt-3' }],
      attempts
    )
    let n = 0
    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'topic',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: true,
      mintMutationId: () => `key-${(n += 1)}`
    })
    expect(result).toEqual({ worktreeId: 'wt-3', name: 'topic-2' })
    expect(attempts).toHaveLength(2)
    // A collision is a genuinely different create, so it gets a distinct key.
    expect(attempts[0]!.params.clientMutationId).toBe('key-1')
    expect(attempts[1]!.params.clientMutationId).toBe('key-2')
    expect(attempts[1]!.params.name).toBe('topic-2')
  })

  it('does not replay an ambiguous cutover when the host lacks idempotency support', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new LogicalClientCutoverError() }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'ray',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: false,
        mintMutationId: () => 'must-not-be-used'
      })
    ).rejects.toBeInstanceOf(LogicalClientCutoverError)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params.clientMutationId).toBeUndefined()
  })
})
