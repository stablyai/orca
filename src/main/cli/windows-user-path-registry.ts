import {
  loadWindowsNativeRegistry,
  WINDOWS_REG_EXPAND_SZ,
  WINDOWS_REG_SZ,
  type WindowsNativeRegistryModule
} from '../windows-native-registry'

export type WindowsUserPathReadResult =
  | { state: 'success'; value: string | null; expandable: boolean }
  | { state: 'unknown'; detail: string }

type WindowsUserPathRegistryReaderOptions = {
  platform?: NodeJS.Platform
  registryLoader?: () => Promise<WindowsNativeRegistryModule>
  now?: () => number
  cacheTtlMs?: number
}

const DEFAULT_CACHE_TTL_MS = 1_000
const USER_ENVIRONMENT_KEY = 'Environment'
const USER_PATH_VALUE = 'Path'
export class WindowsUserPathRegistryReader {
  private readonly platform: NodeJS.Platform
  private readonly registryLoader: () => Promise<WindowsNativeRegistryModule>
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private cached: { readAt: number; result: WindowsUserPathReadResult } | null = null
  private inFlight: Promise<WindowsUserPathReadResult> | null = null
  private generation = 0

  constructor(options: WindowsUserPathRegistryReaderOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.registryLoader = options.registryLoader ?? (async () => loadWindowsNativeRegistry())
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  async read(): Promise<WindowsUserPathReadResult> {
    if (this.platform !== 'win32') {
      return {
        state: 'unknown',
        detail: 'The Windows user PATH registry is only available on Windows.'
      }
    }

    const now = this.now()
    const cacheAge = this.cached ? now - this.cached.readAt : null
    if (this.cached && cacheAge !== null && cacheAge >= 0 && cacheAge < this.cacheTtlMs) {
      return this.cached.result
    }
    if (this.inFlight) {
      return this.inFlight
    }

    const generation = this.generation
    const inFlight = this.readUncached().then((result) => {
      if (result.state === 'success' && generation === this.generation) {
        this.cached = { readAt: this.now(), result }
      }
      return result
    })
    this.inFlight = inFlight
    try {
      return await inFlight
    } finally {
      if (this.inFlight === inFlight) {
        this.inFlight = null
      }
    }
  }

  async readFresh(): Promise<WindowsUserPathReadResult> {
    this.invalidate()
    const generation = this.generation
    const result = await this.readUncached()
    if (result.state === 'success' && generation === this.generation) {
      this.cached = { readAt: this.now(), result }
    }
    return result
  }

  invalidate(): void {
    this.generation += 1
    this.cached = null
    // Why: a mutation must not join a registry read that may predate an external PATH update.
    this.inFlight = null
  }

  private async readUncached(): Promise<WindowsUserPathReadResult> {
    try {
      const registry = await this.registryLoader()
      const key = registry.getRegistryKey(registry.HK.CU, USER_ENVIRONMENT_KEY)
      if (!key || typeof key !== 'object') {
        return {
          state: 'unknown',
          detail: 'Orca could not read the Windows user PATH registry key.'
        }
      }

      const pathEntry = Object.entries(key).find(
        ([name]) => name.toLowerCase() === USER_PATH_VALUE.toLowerCase()
      )?.[1]
      if (!pathEntry) {
        return { state: 'success', value: null, expandable: false }
      }
      if (
        (pathEntry.type !== WINDOWS_REG_SZ && pathEntry.type !== WINDOWS_REG_EXPAND_SZ) ||
        typeof pathEntry.value !== 'string'
      ) {
        return {
          state: 'unknown',
          detail: 'The Windows user PATH registry value has an unsupported format.'
        }
      }
      return {
        state: 'success',
        value: pathEntry.value || null,
        expandable: pathEntry.type === WINDOWS_REG_EXPAND_SZ
      }
    } catch {
      return {
        state: 'unknown',
        detail: 'Orca could not read the Windows user PATH registry value.'
      }
    }
  }
}

const defaultWindowsUserPathRegistryReader = new WindowsUserPathRegistryReader()

export function readWindowsUserPathRegistry(): Promise<WindowsUserPathReadResult> {
  return defaultWindowsUserPathRegistryReader.read()
}

export function readFreshWindowsUserPathRegistry(): Promise<WindowsUserPathReadResult> {
  return defaultWindowsUserPathRegistryReader.readFresh()
}

export function invalidateWindowsUserPathRegistryCache(): void {
  defaultWindowsUserPathRegistryReader.invalidate()
}
