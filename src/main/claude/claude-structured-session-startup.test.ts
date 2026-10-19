import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor,
  claudeOpened
} from './claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

const ACQUIRE = { identity: identityFor(), fence: 7, spawnToken: 'spawn-9' }

function adapterFor(claude: ReturnType<typeof fakeClaude>) {
  const events: ClaudeStructuredSessionEvent[] = []
  return { adapter: adapterAtPublishFor(claude, {}, events), events }
}

describe('Claude host-awaited open', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('publishes the owned process as starting before initialize answers', async () => {
    const claude = fakeClaude({ initDelayMs: 12_000 })
    const { adapter, events } = adapterFor(claude)
    const acquisition = await adapter.acquire(ACQUIRE)
    expect(acquisition).toMatchObject({ providerChildPhase: 'starting', process: { pid: 4321 } })
    expect(acquisition.link).toBeUndefined()
    expect(claude.connections[0].calls).toEqual([])
    expect(events.some((event) => event.type === 'options')).toBe(false)

    const open = claudeOpened(adapter, 'session-1')
    await vi.advanceTimersByTimeAsync(11_999)
    expect(claude.connections[0].calls.map((call) => call.subtype)).toEqual(['initialize'])
    await vi.advanceTimersByTimeAsync(1)
    await expect(open).resolves.toMatchObject({
      link: expect.objectContaining({ handle: expect.objectContaining({ agent: 'claude' }) }),
      reportedOptions: expect.any(Object)
    })
    expect(events.map((event) => event.type)).not.toContain('started')
    await adapter.closeAll()
  })

  it('returns from open without waiting for optional settings', async () => {
    let answerSettings: (value: unknown) => void = () => {}
    const settings = new Promise<unknown>((resolve) => {
      answerSettings = resolve
    })
    const claude = fakeClaude({ settings })
    const { adapter, events } = adapterFor(claude)
    await adapter.acquire(ACQUIRE)
    const opened = await claudeOpened(adapter, 'session-1')
    expect(opened.reportedOptions).toBeDefined()
    expect(claude.connections[0].calls.map((call) => call.subtype)).toContain('get_settings')
    expect(events.some((event) => event.type === 'options-reported')).toBe(false)
    answerSettings({ applied: { model: 'claude-haiku-4-5' }, effective: {} })
    await vi.waitFor(() =>
      expect(events.find((event) => event.type === 'options-reported')).toMatchObject({
        reportedOptions: { model: 'claude-haiku-4-5' }
      })
    )
    await adapter.closeAll()
  })

  it('rejects an advertised signed-out initialize answer for the host to close once', async () => {
    const claude = fakeClaude({ initAccount: { tokenSource: 'none', apiKeySource: 'none' } })
    const { adapter } = adapterFor(claude)
    await adapter.acquire(ACQUIRE)
    await expect(claudeOpened(adapter, 'session-1')).rejects.toThrow('not signed in')
    expect(claude.connections[0].closeCount).toBe(0)
    await adapter.closeSession('session-1')
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('rejects a frame that proves a different provider session', async () => {
    const claude = fakeClaude({ initSessionId: 'foreign-session' })
    const { adapter } = adapterFor(claude)
    await adapter.acquire(ACQUIRE)
    await expect(claudeOpened(adapter, 'session-1')).rejects.toThrow('provider session expected')
    await adapter.closeSession('session-1')
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('lets the host abort a silent initialize wait and close the owned process', async () => {
    const claude = fakeClaude({ initDelayMs: 12_000 })
    const { adapter } = adapterFor(claude)
    const acquisition = await adapter.acquire(ACQUIRE)
    const controller = new AbortController()
    const open = adapter.open({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquisition.acquisitionGeneration ?? null,
      signal: controller.signal
    })
    controller.abort(new Error('host start expired'))
    await expect(open).rejects.toThrow('host start expired')
    await adapter.closeSession('session-1')
    expect(claude.connections[0].closeCount).toBe(1)
  })
})
