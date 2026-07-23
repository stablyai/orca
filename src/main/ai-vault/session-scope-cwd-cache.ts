export const AI_VAULT_SCOPE_CWD_CACHE_MAX_ENTRIES = 2_048
export const AI_VAULT_SCOPE_CWD_CACHE_KEY_MAX_UTF8_BYTES = 32 * 1024
export const AI_VAULT_SCOPE_CWD_CACHE_VALUE_MAX_UTF8_BYTES = 128 * 1024
export const AI_VAULT_SCOPE_CWD_CACHE_MAX_RETAINED_UTF8_BYTES = 8 * 1024 * 1024

const ENTRY_OVERHEAD_BYTES = 128

type RetainedCwd = { cwd: string; bytes: number }

export class AiVaultScopeCwdCache {
  private readonly entries = new Map<string, RetainedCwd>()
  private retainedBytes = 0

  constructor(
    private readonly limits: {
      maxEntries: number
      maxRetainedBytes: number
    } = {
      maxEntries: AI_VAULT_SCOPE_CWD_CACHE_MAX_ENTRIES,
      maxRetainedBytes: AI_VAULT_SCOPE_CWD_CACHE_MAX_RETAINED_UTF8_BYTES
    }
  ) {}

  get(projectDir: string): string | undefined {
    const retained = this.entries.get(projectDir)
    if (!retained) {
      return undefined
    }
    this.entries.delete(projectDir)
    this.entries.set(projectDir, retained)
    return retained.cwd
  }

  set(projectDir: string, cwd: string): void {
    this.delete(projectDir)
    const keyBytes = Buffer.byteLength(projectDir, 'utf8')
    const valueBytes = Buffer.byteLength(cwd, 'utf8')
    const bytes = keyBytes + valueBytes + ENTRY_OVERHEAD_BYTES
    if (
      keyBytes > AI_VAULT_SCOPE_CWD_CACHE_KEY_MAX_UTF8_BYTES ||
      valueBytes > AI_VAULT_SCOPE_CWD_CACHE_VALUE_MAX_UTF8_BYTES ||
      bytes > this.limits.maxRetainedBytes
    ) {
      return
    }
    while (
      this.entries.size >= this.limits.maxEntries ||
      this.retainedBytes + bytes > this.limits.maxRetainedBytes
    ) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {
        return
      }
      this.delete(oldest)
    }
    this.entries.set(projectDir, { cwd, bytes })
    this.retainedBytes += bytes
  }

  clear(): void {
    this.entries.clear()
    this.retainedBytes = 0
  }

  inspectForTests(): { keys: string[]; retainedBytes: number } {
    return { keys: [...this.entries.keys()], retainedBytes: this.retainedBytes }
  }

  private delete(projectDir: string): void {
    const retained = this.entries.get(projectDir)
    if (!retained) {
      return
    }
    this.entries.delete(projectDir)
    this.retainedBytes -= retained.bytes
  }
}
