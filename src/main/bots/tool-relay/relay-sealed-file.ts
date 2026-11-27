// A small versioned JSON file of sealed relay entries in Orca's app data. Writes are durable (temp
// file flushed, then renamed) and run one at a time, so a later write never lands under an earlier.
import { readFile } from 'node:fs/promises'
import { jsonObject } from '../../../shared/json-stream/json-value-property'
import { getSecretStore, hasSecretStore } from '../../../shared/secure-storage/secret-store'
import { durableWriteTempPath, writeFileDurable } from '../../filesystem/durable-file-write'

/**
 * Only a store sealed by the real OS keychain keeps a token at rest: not Linux `basic_text`, and not
 * a mock keychain (a test switch), which seals with a fixed password.
 */
export function relaySealingProtected(): boolean {
  if (!hasSecretStore()) {
    return false
  }
  const store = getSecretStore()
  return (
    store.isEncryptionAvailable() &&
    store.describeSealing?.().kind === 'os-keychain' &&
    store.mockKeychain?.() !== true
  )
}

export async function sealRelaySecret(plain: string): Promise<string> {
  const store = getSecretStore()
  const sealed = store.encryptStringAsync
    ? await store.encryptStringAsync(plain)
    : store.encryptString(plain)
  return sealed.toString('base64')
}

/** Rejects while the keychain can't open it (locked, or another app's key). */
export async function unsealRelaySecret(sealed: string): Promise<string> {
  const store = getSecretStore()
  const cipher = Buffer.from(sealed, 'base64')
  return store.decryptStringAsync
    ? await store.decryptStringAsync(cipher)
    : store.decryptString(cipher)
}

/** How often entries the keychain refused may be retried. */
export const RELAY_UNLOCK_RETRY_MS = 10_000

/** One retry of keychain-refused entries per `RELAY_UNLOCK_RETRY_MS` across every kept relay file. */
export class RelayUnlockThrottle {
  private last = Number.NEGATIVE_INFINITY

  constructor(private readonly now: () => number = Date.now) {}

  due(): boolean {
    if (this.now() - this.last < RELAY_UNLOCK_RETRY_MS) {
      return false
    }
    this.last = this.now()
    return true
  }
}

export const relayUnlockThrottle = new RelayUnlockThrottle()

export class RelaySealedFile<Entry> {
  private running: Promise<void> | null = null
  private queued: Promise<void> | null = null
  private latest: () => readonly Entry[] = () => []

  constructor(
    private readonly path: string,
    private readonly isEntry: (value: unknown) => value is Entry,
    private readonly publish: (path: string, payload: string) => Promise<unknown> = (
      target,
      payload
    ) => writeFileDurable(durableWriteTempPath(target), target, payload, 0o600)
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
      const parsed = jsonObject(JSON.parse(text))
      const entries = parsed?.version === 1 ? parsed.entries : undefined
      return Array.isArray(entries) ? entries.filter(this.isEntry) : []
    } catch {
      return []
    }
  }

  /**
   * Resolves once the file durably holds `snapshot()` as taken at or after this call; rejects when
   * that write failed. Writes run one at a time and coalesce: while one runs, every later call
   * shares the single next write, which takes the state as it is when it starts.
   */
  write(snapshot: () => readonly Entry[]): Promise<void> {
    this.latest = snapshot
    // A queued write still to start takes this change; starting another would race it.
    if (!this.running && !this.queued) {
      return this.start()
    }
    this.queued ??= (this.running ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        this.queued = null
        return this.start()
      })
    return this.queued
  }

  private start(): Promise<void> {
    const entries = this.latest()
    const run = this.publish(this.path, `${JSON.stringify({ version: 1, entries })}\n`).then(
      () => {}
    )
    this.running = run
    const settled = (): void => {
      if (this.running === run) {
        this.running = null
      }
    }
    run.then(settled, settled)
    return run
  }
}
