import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import type { HandlerContext } from '../dispatch'
import type { ResourceEvidence } from '../../shared/resource-evidence-types'
import { RESOURCE_HANDLERS } from './resource'

const evidence: ResourceEvidence = {
  queriedAt: '2026-09-09T12:00:00.000Z',
  providers: {
    codex: {
      available: true,
      status: 'ok',
      sourceUpdatedAt: '2026-09-09T11:52:00.000Z',
      dataAgeMs: 480000,
      rateLimited: false,
      retryAt: null,
      windows: [
        {
          role: 'BURST',
          scope: 'session',
          windowMinutes: 300,
          remainingRatio: 0.81,
          remainingRatioGranularity: 0.01,
          resetAt: '2026-09-09T14:38:00.000Z',
          resetAtSource: 'unknown'
        }
      ]
    }
  }
}

function context(call: ReturnType<typeof vi.fn>, overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    client: { call } as unknown as RuntimeClient,
    cwd: process.cwd(),
    json: true,
    flags: new Map(),
    ...overrides
  }
}

afterEach(() => vi.restoreAllMocks())

describe('resource status CLI handler', () => {
  it('emits stable, parseable JSON with the evidence and no decorative output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn().mockResolvedValue({ id: 'r1', ok: true, result: evidence, _meta: { runtimeId: 't' } })

    await RESOURCE_HANDLERS['resource status']!(context(call))

    expect(call).toHaveBeenCalledWith('resource.status', { refresh: false })
    expect(log).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(log.mock.calls[0]![0] as string)
    expect(parsed.result.providers.codex.windows[0].role).toBe('BURST')
    expect(JSON.stringify(parsed)).not.toContain('email')
  })

  it('maps --refresh to the RPC parameter', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn().mockResolvedValue({ id: 'r1', ok: true, result: evidence, _meta: { runtimeId: 't' } })

    await RESOURCE_HANDLERS['resource status']!(context(call, { flags: new Map([['refresh', true]]) }))

    expect(call).toHaveBeenCalledWith('resource.status', { refresh: true })
  })

  it('renders a concise human summary without --json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn().mockResolvedValue({ id: 'r1', ok: true, result: evidence, _meta: { runtimeId: 't' } })

    await RESOURCE_HANDLERS['resource status']!(context(call, { json: false }))

    const output = log.mock.calls[0]![0] as string
    expect(output).toContain('codex: available')
    expect(output).toContain('session [BURST, 300m]: ~81% left')
  })
})
