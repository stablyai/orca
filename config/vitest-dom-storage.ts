type StorageEntryMap = Map<string, string>

function createMemoryStorage(entries: StorageEntryMap): Storage {
  return {
    get length() {
      return entries.size
    },
    clear() {
      entries.clear()
    },
    getItem(key: string) {
      return entries.get(key) ?? null
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null
    },
    removeItem(key: string) {
      entries.delete(key)
    },
    setItem(key: string, value: string) {
      entries.set(key, String(value))
    }
  }
}

function defineStorage(target: Window & typeof globalThis, property: 'localStorage'): void {
  const entries = new Map<string, string>()
  Object.defineProperty(target, property, {
    configurable: true,
    value: createMemoryStorage(entries)
  })
}

if (typeof window !== 'undefined') {
  // Why: Node 26 can expose a DOM-like test window without Storage unless
  // --localstorage-file is set; DOM tests expect per-worker in-memory storage.
  defineStorage(window, 'localStorage')
}
