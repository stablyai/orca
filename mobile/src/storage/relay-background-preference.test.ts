import { beforeEach, describe, expect, it, vi } from 'vitest'

const stored = new Map<string, string>()
const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

beforeEach(() => {
  vi.resetModules()
  stored.clear()
  storage.getItem.mockReset().mockImplementation(async (key: string) => stored.get(key) ?? null)
  storage.setItem.mockReset().mockImplementation(async (key: string, value: string) => {
    stored.set(key, value)
  })
})

describe('Relay background preference', () => {
  it('defaults to the short grace and persists an explicit opt-in across reloads', async () => {
    const preference = await import('./relay-background-preference')
    expect(await preference.loadRelayBackgroundExtended()).toBe(false)
    await preference.saveRelayBackgroundExtended(true)
    expect(preference.isRelayBackgroundExtended()).toBe(true)

    vi.resetModules()
    const reloaded = await import('./relay-background-preference')
    expect(await reloaded.loadRelayBackgroundExtended()).toBe(true)
    expect(reloaded.isRelayBackgroundExtended()).toBe(true)
    await reloaded.saveRelayBackgroundExtended(false)
    vi.resetModules()
    expect(
      await (await import('./relay-background-preference')).loadRelayBackgroundExtended()
    ).toBe(false)
  })

  it('does not opt in when the stored value is corrupt', async () => {
    storage.getItem.mockResolvedValue('invalid')
    const preference = await import('./relay-background-preference')
    expect(await preference.loadRelayBackgroundExtended()).toBe(false)
    expect(preference.isRelayBackgroundExtended()).toBe(false)
  })

  it('publishes a saved choice before storage finishes', async () => {
    let finishWrite: () => void = () => {}
    storage.setItem.mockImplementationOnce(
      (key: string, value: string) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            stored.set(key, value)
            resolve()
          }
        })
    )
    const preference = await import('./relay-background-preference')
    const saving = preference.saveRelayBackgroundExtended(true)
    await Promise.resolve()
    expect(preference.isRelayBackgroundExtended()).toBe(true)
    finishWrite()
    await saving
    expect(preference.isRelayBackgroundExtended()).toBe(true)
  })

  it('preserves the last saved policy when a save fails', async () => {
    const preference = await import('./relay-background-preference')
    await preference.saveRelayBackgroundExtended(true)
    storage.setItem.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(preference.saveRelayBackgroundExtended(false)).rejects.toThrow(
      'storage unavailable'
    )
    expect(preference.isRelayBackgroundExtended()).toBe(true)
    await preference.saveRelayBackgroundExtended(false)
    expect(preference.isRelayBackgroundExtended()).toBe(false)
  })

  it('does not let an older hydration overwrite a newer saved choice', async () => {
    let finishRead: (value: string | null) => void = () => {}
    storage.getItem.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        })
    )
    const preference = await import('./relay-background-preference')
    const loading = preference.loadRelayBackgroundExtended()
    await Promise.resolve()
    await preference.saveRelayBackgroundExtended(true)
    finishRead(null)
    expect(await loading).toBe(true)
    expect(preference.isRelayBackgroundExtended()).toBe(true)
  })
})
