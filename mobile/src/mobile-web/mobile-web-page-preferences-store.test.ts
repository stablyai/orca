import { describe, expect, it, vi } from 'vitest'
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
import {
  mobileWebPagePreferencesStorageKey,
  runMobileWebPagePreferences
} from './mobile-web-page-preferences-store'
function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    })
  }
  const run = (host: string, payload: Parameters<typeof runMobileWebPagePreferences>[1]) =>
    runMobileWebPagePreferences(host, payload, storage)
  return { values, storage, run }
}
describe('bounded host-scoped page preferences', () => {
  it('isolates hosts and namespaces, survives page changes, and cannot address native storage keys', async () => {
    const f = fixture()
    f.values.set('orca:deviceToken', 'secret')
    await f.run('host-a', {
      namespace: 'future.settings',
      action: 'write',
      entries: [['orca:deviceToken', 'page value']]
    })
    expect(
      await f.run('host-a', {
        namespace: 'future.settings',
        action: 'read',
        keys: ['orca:deviceToken']
      })
    ).toEqual({ entries: [['orca:deviceToken', 'page value']] })
    expect(
      await f.run('host-b', {
        namespace: 'future.settings',
        action: 'read',
        keys: ['orca:deviceToken']
      })
    ).toEqual({ entries: [['orca:deviceToken', null]] })
    expect(
      await f.run('host-a', { namespace: 'another', action: 'read', keys: ['orca:deviceToken'] })
    ).toEqual({ entries: [['orca:deviceToken', null]] })
    await f.run('host-a', { namespace: 'future.settings', action: 'clear' })
    expect(f.values.get('orca:deviceToken')).toBe('secret')
    expect(mobileWebPagePreferencesStorageKey('host-a')).not.toContain('host-a')
  })

  it('serializes concurrent updates without dropping sibling keys', async () => {
    const f = fixture()
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        f.run('concurrent', {
          namespace: 'settings',
          action: 'write',
          entries: [[String(index), String(index)]]
        })
      )
    )
    const result = await f.run('concurrent', { namespace: 'settings', action: 'keys' })
    expect(result).toEqual({ keys: Array.from({ length: 20 }, (_, index) => String(index)) })
  })

  it('rejects byte and total limits without replacing existing preferences', async () => {
    const f = fixture()
    const payload = {
      namespace: 'settings',
      action: 'write' as const,
      entries: [['a', 'saved']] as [string, string][]
    }
    await f.run('limited', payload)
    const before = f.values.get(mobileWebPagePreferencesStorageKey('limited'))
    await expect(
      f.run('limited', { ...payload, entries: [['a', '😀'.repeat(20000)]] })
    ).rejects.toMatchObject({ code: 'too_large' })
    await expect(
      f.run('limited', {
        ...payload,
        entries: Array.from({ length: 40 }, (_, index) => [String(index), 'x'.repeat(64 * 1024)])
      })
    ).rejects.toMatchObject({ code: 'too_large' })
    expect(f.values.get(mobileWebPagePreferencesStorageKey('limited'))).toBe(before)
  })

  it('keeps a reset and a read working over a corrupt or oversized blob', async () => {
    const f = fixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const key = mobileWebPagePreferencesStorageKey('broken')
    f.values.set(key, 'bad-json')
    expect(
      await f.run('broken', { namespace: 'settings', action: 'read', keys: ['a', 'b'] })
    ).toEqual({
      entries: [
        ['a', null],
        ['b', null]
      ]
    })
    expect(f.values.get(key)).toBe('bad-json')
    await expect(f.run('broken', { namespace: 'settings', action: 'clear' })).resolves.toEqual({
      updated: true
    })
    await expect(
      f.run('broken', { namespace: 'settings', action: 'write', entries: [['a', 'saved']] })
    ).resolves.toEqual({ updated: true })

    f.values.set(key, JSON.stringify([['settings', [['a', 'x'.repeat(3 * 1024 * 1024)]]]]))
    expect(await f.run('broken', { namespace: 'settings', action: 'read', keys: ['a'] })).toEqual({
      entries: [['a', null]]
    })
    await expect(f.run('broken', { namespace: 'settings', action: 'clear' })).resolves.toEqual({
      updated: true
    })
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('does not overwrite unreadable storage and recovers after a failed write', async () => {
    const f = fixture()
    const key = mobileWebPagePreferencesStorageKey('broken')
    f.values.set(key, 'bad-json')
    const payload = {
      namespace: 'settings',
      action: 'write' as const,
      entries: [['a', 'saved']] as [string, string][]
    }
    await expect(f.run('broken', payload)).rejects.toThrow()
    expect(f.values.get(key)).toBe('bad-json')
    f.values.delete(key)
    f.storage.setItem.mockRejectedValueOnce(new Error('disk failure'))
    await expect(f.run('broken', payload)).rejects.toThrow('disk failure')
    await expect(f.run('broken', payload)).resolves.toEqual({ updated: true })
  })
})
