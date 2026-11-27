// A small versioned JSON file of sealed relay entries in Orca's app data. Writes are durable (temp
// file flushed, then renamed) and run one at a time, so a later write never lands under an earlier.
import { readFile } from 'node:fs/promises'
import { getSecretStore, hasSecretStore } from '../../../shared/secure-storage/secret-store'
import { durableWriteTempPath, writeFileDurable } from '../../filesystem/durable-file-write'

/** Only a store sealed by the OS keychain keeps a token at rest (not Linux `basic_text`). */
export function relaySealingProtected(): boolean {
  if (!hasSecretStore()) {
    return false
  }
  const store = getSecretStore()
  return store.isEncryptionAvailable() && store.describeSealing?.().kind === 'os-keychain'
}

export async function sealRelaySecret(plain: string): Promise<string> {
  const store = getSecretStore()
  const sealed = store.encryptStringAsync
    ? await store.encryptStringAsync(plain)
    : store.encryptString(plain)
  return sealed.toString('base64')
}

/** Throws while the keychain can't open it (locked, or another app's key). */
export function unsealRelaySecret(sealed: string): string {
  return getSecretStore().decryptString(Buffer.from(sealed, 'base64'))
}

export class RelaySealedFile<Entry> {
  private writing: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly isEntry: (value: unknown) => value is Entry
  ) {}

  /** The file's entries; none when it's missing or unreadable (a bad entry alone is skipped). */
  async read(): Promise<Entry[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return []
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== 1
      ) {
        return []
      }
      const entries = (parsed as { entries?: unknown }).entries
      return Array.isArray(entries) ? entries.filter(this.isEntry) : []
    } catch {
      return []
    }
  }

  /** Resolves once `entries` is durably the whole file; rejects when it couldn't be written. */
  write(entries: readonly Entry[]): Promise<void> {
    const payload = `${JSON.stringify({ version: 1, entries })}\n`
    const next = this.writing.then(() =>
      writeFileDurable(durableWriteTempPath(this.path), this.path, payload, 0o600)
    )
    this.writing = next.catch(() => {})
    return next
  }
}
