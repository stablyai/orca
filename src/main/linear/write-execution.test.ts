import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const clearToken = vi.fn()
const isAuthError = vi.fn()
const linearClientOptions: { apiKey?: string; signal?: AbortSignal }[] = []

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

vi.mock('./client', () => ({
  getClients: vi.fn(),
  isAuthError: (...args: unknown[]) => isAuthError(...args)
}))

vi.mock('./linear-sdk', () => ({
  loadLinearSdk: () => ({
    AuthenticationLinearError: class extends Error {},
    LinearClient: class {
      readonly perCall = true
      constructor(options: { apiKey?: string; signal?: AbortSignal }) {
        linearClientOptions.push(options)
      }
    }
  })
}))

function entry(): LinearClientForWorkspace {
  return {
    apiKey: 'lin_api_key',
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Acme',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: { shared: true }
  } as unknown as LinearClientForWorkspace
}

describe('Linear write execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    linearClientOptions.length = 0
    isAuthError.mockReturnValue(false)
  })

  it.each([
    ['id has already been used', 'duplicate_id'],
    ['connect ENOTFOUND api.linear.app', 'network'],
    ['The operation was aborted', 'unconfirmed'],
    ['fetch failed: socket hang up', 'unconfirmed'],
    ['Project name is required', 'failed']
  ])('classifies %s as %s', async (message, kind) => {
    const { classifyLinearWriteFailure } = await import('./write-execution')
    expect(classifyLinearWriteFailure(new Error(message))).toMatchObject({
      kind,
      name: 'LinearWriteFailure'
    })
  })

  it('classifies a transport error carried on cause.code', async () => {
    const { classifyLinearWriteFailure } = await import('./write-execution')
    const error = Object.assign(new Error('request to api failed'), {
      cause: { code: 'ECONNREFUSED' }
    })
    expect(classifyLinearWriteFailure(error)).toMatchObject({ kind: 'network' })
  })

  it('returns an existing failure unchanged', async () => {
    const { LinearWriteFailure, classifyLinearWriteFailure } = await import('./write-execution')
    const failure = new LinearWriteFailure('unconfirmed', 'already classified')
    expect(classifyLinearWriteFailure(failure)).toBe(failure)
  })

  it('reuses the shared client without a signal and builds a per-call one with it', async () => {
    const { runLinearWrite } = await import('./write-execution')
    const controller = new AbortController()

    await expect(runLinearWrite(entry(), undefined, async (client) => client)).resolves.toEqual({
      shared: true
    })
    expect(linearClientOptions).toEqual([])

    await expect(
      runLinearWrite(entry(), controller.signal, async (client) => client)
    ).resolves.toMatchObject({ perCall: true })
    expect(linearClientOptions).toEqual([{ apiKey: 'lin_api_key', signal: controller.signal }])
  })

  it('clears the token and rethrows auth errors instead of classifying them', async () => {
    const { runLinearWrite } = await import('./write-execution')
    isAuthError.mockReturnValue(true)

    await expect(
      runLinearWrite(entry(), undefined, async () => {
        throw new Error('authentication failed')
      })
    ).rejects.toThrow('authentication failed')
    expect(clearToken).toHaveBeenCalledWith('workspace-1')
  })

  it('maps only true entity misses to null lookups', async () => {
    const { runLinearLookup, isLinearLookupMiss } = await import('./write-execution')
    const miss = new Error('Entity not found: Project - Could not find referenced Project.')

    expect(isLinearLookupMiss(miss)).toBe(true)
    expect(isLinearLookupMiss(new Error('Entity not found'))).toBe(false)
    await expect(
      runLinearLookup(entry(), async () => {
        throw miss
      })
    ).resolves.toBeNull()
    await expect(
      runLinearLookup(entry(), async () => {
        throw new Error('rate limited')
      })
    ).rejects.toThrow('rate limited')
  })

  it('wraps read-back failures as unconfirmed', async () => {
    const { confirmLinearWrite } = await import('./write-execution')

    await expect(
      confirmLinearWrite('could not be retrieved', async () => {
        throw new Error('boom')
      })
    ).rejects.toMatchObject({ kind: 'unconfirmed', message: 'could not be retrieved' })
  })
})
