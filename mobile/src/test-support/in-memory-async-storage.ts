import type AsyncStorage from '@react-native-async-storage/async-storage'

type InMemoryAsyncStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>

export function createInMemoryAsyncStorage(): InMemoryAsyncStorage {
  const values = new Map<string, string>()
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: async (key: string) => {
      values.delete(key)
    }
  }
}
