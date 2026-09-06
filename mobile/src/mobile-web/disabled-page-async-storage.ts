type StorageCallback<T = void> = (error: Error | null, result?: T) => void

function resolved<T>(value: T, callback?: StorageCallback<T>): Promise<T> {
  callback?.(null, value)
  return Promise.resolve(value)
}

const disabledPageAsyncStorage = {
  getItem(_key: string, callback?: StorageCallback<string | null>) {
    return resolved<string | null>(null, callback)
  },
  setItem(_key: string, _value: string, callback?: StorageCallback) {
    return resolved(undefined, callback)
  },
  removeItem(_key: string, callback?: StorageCallback) {
    return resolved(undefined, callback)
  },
  mergeItem(_key: string, _value: string, callback?: StorageCallback) {
    return resolved(undefined, callback)
  },
  clear(callback?: StorageCallback) {
    return resolved(undefined, callback)
  },
  getAllKeys(callback?: StorageCallback<string[]>) {
    return resolved<string[]>([], callback)
  },
  flushGetRequests() {},
  multiGet(keys: readonly string[], callback?: StorageCallback<[string, string | null][]>) {
    return resolved(
      keys.map((key): [string, string | null] => [key, null]),
      callback
    )
  },
  multiSet(_entries: readonly [string, string][], callback?: StorageCallback) {
    return resolved(undefined, callback)
  },
  multiRemove(_keys: readonly string[], callback?: StorageCallback) {
    return resolved(undefined, callback)
  },
  multiMerge(_entries: readonly [string, string][], callback?: StorageCallback) {
    return resolved(undefined, callback)
  }
}

export function useAsyncStorage(key: string) {
  return {
    getItem: (callback?: StorageCallback<string | null>) =>
      disabledPageAsyncStorage.getItem(key, callback),
    setItem: (value: string, callback?: StorageCallback) =>
      disabledPageAsyncStorage.setItem(key, value, callback),
    mergeItem: (value: string, callback?: StorageCallback) =>
      disabledPageAsyncStorage.mergeItem(key, value, callback),
    removeItem: (callback?: StorageCallback) => disabledPageAsyncStorage.removeItem(key, callback)
  }
}

export default disabledPageAsyncStorage
