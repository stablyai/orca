import { PAIRING_DEVICE_TOKEN_MAX_CHARACTERS } from './types'

export const HOST_TOKEN_CACHE_MAX_ENTRIES = 64
export const HOST_TOKEN_CACHE_MAX_ENTRY_CODE_UNITS = 64 * 1024

export class HostTokenCache {
  private readonly entries = new Map<string, string>()

  get(hostId: string): string | undefined {
    return this.entries.get(hostId)
  }

  delete(hostId: string): void {
    this.entries.delete(hostId)
  }

  clear(): void {
    this.entries.clear()
  }

  remember(hostId: string, token: string, allowEviction: boolean): void {
    if (
      hostId.length + token.length > HOST_TOKEN_CACHE_MAX_ENTRY_CODE_UNITS ||
      token.length > PAIRING_DEVICE_TOKEN_MAX_CHARACTERS
    ) {
      this.entries.delete(hostId)
      return
    }
    if (this.entries.has(hostId)) {
      this.entries.delete(hostId)
    } else if (this.entries.size >= HOST_TOKEN_CACHE_MAX_ENTRIES) {
      if (!allowEviction) {
        return
      }
      const oldestHostId = this.entries.keys().next().value
      if (oldestHostId !== undefined) {
        this.entries.delete(oldestHostId)
      }
    }
    this.entries.set(hostId, token)
  }
}
