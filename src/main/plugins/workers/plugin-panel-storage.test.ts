import { describe, expect, it, vi } from 'vitest'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'

function createServices(storageSet: PluginHostServices['storage']['set']): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: {
      get: vi.fn(),
      set: storageSet,
      delete: vi.fn(),
      keys: vi.fn().mockReturnValue([])
    },
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: null }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn()
    },
    settings: {
      getAll: vi.fn().mockReturnValue({}),
      set: vi.fn().mockReturnValue({ ok: true })
    }
  }
}

describe('panel private storage', () => {
  it('requires consent and prevents stale concurrent writes', async () => {
    let value: string | null = null
    const services = createServices(
      vi.fn<PluginHostServices['storage']['set']>((_pluginId, _key, next) => {
        value = typeof next === 'string' ? next : null
        return { ok: true }
      })
    )
    vi.mocked(services.storage.get).mockImplementation(() => value)
    const request = (
      expected: null,
      next: string | null,
      capabilities: 'storage:own'[] = ['storage:own']
    ) =>
      executePluginHostCall({
        pluginId: 'samples.demo',
        method: 'storage.compareAndSet',
        params: { key: 'notes', expected, value: next },
        surface: 'panel',
        grantedCapabilities: capabilities,
        services,
        audit: { record: vi.fn().mockResolvedValue(undefined) }
      })
    expect(await request(null, 'denied', [])).toMatchObject({ ok: false })
    expect(value).toBeNull()
    expect(await request(null, null)).toEqual({ ok: true, value: { swapped: true } })
    const results = await Promise.all([request(null, 'first'), request(null, 'second')])
    expect(results).toContainEqual({ ok: true, value: { swapped: true } })
    expect(results).toContainEqual({ ok: true, value: { swapped: false } })
    expect(value).toBe('first')
    expect(
      await executePluginHostCall({
        pluginId: 'samples.demo',
        method: 'storage.get',
        params: { key: 'notes' },
        surface: 'panel',
        grantedCapabilities: ['storage:own'],
        services,
        audit: { record: vi.fn().mockResolvedValue(undefined) }
      })
    ).toMatchObject({ ok: true, value: { value: 'first' } })
  })
})
