// Abstraction over secret stores for claude-accounts. Defined as types so the
// compiler enforces shapes at every call site (per AGENTS.md: prefer .ts over .d.ts).
export type SecretsBackendId = 'keychain' | 'encrypted-file'

export type SecretsStorage = {
  backendId: SecretsBackendId
  read(service: string, account: string): Promise<string | null>
  write(service: string, account: string, value: string): Promise<void>
  delete(service: string, account: string): Promise<void>
}

// Probe result from backend selection. `ok: false` carries a tagged reason so
// the selector can decide whether to fall back to encrypted-file storage.
export type SecretsBackendProbe =
  | { ok: true; backendId: SecretsBackendId }
  | {
      ok: false
      reason:
        | 'keychain-unavailable'
        | 'keychain-write-failed'
        | 'forced-encrypted-file'
        | 'unsupported-platform'
      message: string
    }
