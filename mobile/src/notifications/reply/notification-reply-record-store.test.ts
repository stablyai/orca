import { expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => new Map<string, string>())
const keychain = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => disk.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      disk.set(key, value)
    },
    getAllKeys: async () => [...disk.keys()],
    removeItem: async (key: string) => {
      disk.delete(key)
    }
  }
}))
vi.mock('../../host-credentials/pairing-keychain', () => ({
  readPairingKeychainItem: async (key: string) => keychain.get(key) ?? null,
  writePairingKeychainItem: async (key: string, value: string) => {
    keychain.set(key, value)
  }
}))

it('seals recovery text across process restarts and binds ciphertext to its record', async () => {
  let { notificationReplyRecords: store } = await import('./notification-reply-record-store')
  const id = 'orca:notificationReply:original'
  const text = JSON.stringify({ state: 'sending', text: 'private recovery text' })
  await store.setItem(id, text)
  expect(disk.get(id)).toMatch(/^sealed:v1:/)
  expect(disk.get(id)).not.toContain('private recovery text')
  vi.resetModules()
  store = (await import('./notification-reply-record-store')).notificationReplyRecords
  expect(await store.getItem(id)).toBe(text)
  disk.set('orca:notificationReply:copied', disk.get(id)!)
  await expect(store.getItem('orca:notificationReply:copied')).rejects.toThrow(
    'could not be opened'
  )
  disk.set('orca:notificationReply:legacy', text)
  expect(await store.getItem('orca:notificationReply:legacy')).toBe(text)
  expect(disk.get('orca:notificationReply:legacy')).toMatch(/^sealed:v1:/)
})
