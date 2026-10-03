import type { FileStat, FileUploadSession, IFilesystemProvider } from '../providers/types'

export type CreatedRemoteEntry = {
  path: string
  kind: 'file' | 'directory'
  /** Identity taken right after our exclusive create, so a replaced node is recognised. */
  identity: Promise<FileStat | null>
  /** Upper bound on the bytes this import wrote into the file (read-side count, so never low). */
  maxBytes: number
}

// Why: a folder of thousands of small files must not park thousands of relay requests at once
// on the mux the explorer, watchers and terminals share; the rollback awaits them anyway.
const IDENTITY_LSTAT_CONCURRENCY = 16
// Why: an identity read that starts long after the create may observe a node someone swapped in
// meanwhile; past this it is treated as unverifiable, so the window stays bounded however long
// the queue grows.
export const IDENTITY_READ_DEADLINE_MS = 1000
// Why: a slot freed at the deadline leaves its request pending on the relay; past this many
// unanswered requests, new identities are skipped (unverifiable) instead of piling up.
export const IDENTITY_OUTSTANDING_LIMIT = 64
// Why: a relay that stops answering must not hold the rollback; a timed-out check only ever keeps.
// Long enough that a congested but healthy relay does not trip the breaker below.
export const ROLLBACK_LSTAT_TIMEOUT_MS = 30_000

// Why: the backlog lives on the relay, so the limit is shared by every import on one connection.
const outstandingIdentityRequests = new WeakMap<IFilesystemProvider, { count: number }>()

function expireAfter(ms: number): { expired: Promise<null>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return { expired, cancel: () => clearTimeout(timer) }
}

/**
 * What one tracked SSH import created, so a cancel can undo exactly that.
 *
 * Why not `rm -rf` of the import root: another client (an agent, an editor) may
 * write into the new folder before the cancel lands, and those files are not ours.
 */
export class SshImportCreatedLedger {
  private readonly created: CreatedRemoteEntry[] = []
  private readonly removed = new Set<string>()
  private identityReadsInFlight = 0
  private relayStalled = false
  private readonly identityReadQueue: (() => void)[] = []

  constructor(
    private readonly provider: IFilesystemProvider,
    private readonly session: FileUploadSession,
    private readonly assertCurrent?: () => void
  ) {}

  /** Records an entry our exclusive create just made; the returned entry takes later byte counts. */
  record(path: string, kind: 'file' | 'directory', maxBytes: number): CreatedRemoteEntry {
    // Why: not awaited, so the transfer never waits on it; the create was exclusive, so the
    // identity this reads is ours.
    const lstat = this.provider.lstat?.bind(this.provider)
    const createdAt = performance.now()
    const late = (): boolean => performance.now() - createdAt > IDENTITY_READ_DEADLINE_MS
    // Why: a reply that arrives in time proves the remote read ran in time; the start check only skips doomed reads.
    // Why: a read that never replies must not hold the rollback; at the deadline it is unverifiable.
    const identity = lstat ? this.readIdentity(path, lstat, late) : Promise.resolve(null)
    const entry = { path, kind, identity, maxBytes }
    this.created.push(entry)
    return entry
  }

  private readIdentity(
    path: string,
    lstat: (path: string) => Promise<FileStat>,
    late: () => boolean
  ): Promise<FileStat | null> {
    const { expired, cancel } = expireAfter(IDENTITY_READ_DEADLINE_MS)
    const read = this.withIdentityReadSlot(async () => {
      const outstanding = outstandingIdentityRequests.get(this.provider) ?? { count: 0 }
      if (late() || outstanding.count >= IDENTITY_OUTSTANDING_LIMIT) {
        return null
      }
      outstanding.count += 1
      outstandingIdentityRequests.set(this.provider, outstanding)
      try {
        return await lstat(path)
      } finally {
        outstanding.count -= 1
      }
    }, expired)
      .then((stat) => (late() ? null : stat))
      .catch(() => null)
    void read.finally(cancel)
    return Promise.race([read, expired])
  }

  private async withIdentityReadSlot<T>(
    read: () => Promise<T> | T,
    expired: Promise<null>
  ): Promise<T> {
    if (this.identityReadsInFlight >= IDENTITY_LSTAT_CONCURRENCY) {
      await new Promise<void>((resolve) => this.identityReadQueue.push(resolve))
    }
    this.identityReadsInFlight += 1
    const pending = (async () => read())()
    const release = (): void => {
      this.identityReadsInFlight -= 1
      this.identityReadQueue.shift()?.()
    }
    // Why: a stalled read gives its slot back at the deadline; its late reply is discarded anyway.
    void Promise.race([pending, expired]).then(release, release)
    return pending
  }

  /**
   * What this import created that is still on the host, in reverse creation order:
   * a rollback's failures, or everything when no rollback ran (a dropped connection).
   */
  get remaining(): readonly string[] {
    return this.created
      .toReversed()
      .filter((entry) => !this.removed.has(entry.path))
      .map((entry) => entry.path)
  }

  /** Children first (reverse creation order); a non-empty directory is kept. Idempotent. */
  async rollback(): Promise<void> {
    for (const entry of this.created.toReversed()) {
      if (this.removed.has(entry.path)) {
        continue
      }
      try {
        // Why: a replacement session must never inherit cleanup from the retired owner.
        this.assertCurrent?.()
        await this.remove(entry)
        this.removed.add(entry.path)
      } catch {
        // Why: kept in `remaining`, which the result reports instead of swallowing.
      }
    }
  }

  /**
   * Proves the path still holds what we created: lstat (a symlink is never ours), the same
   * dev/ino as at creation (an atomic-rename save or a swapped node changes them), and no more
   * bytes than we wrote. A path we cannot verify is kept and reported, never removed.
   */
  private async assertStillOurs(entry: CreatedRemoteEntry): Promise<void> {
    if (!this.provider.lstat) {
      throw new Error(`cannot verify ${entry.path} before removing it`)
    }
    // Why: once one check timed out the relay is stalled; later entries are kept without asking,
    // so a stalled relay costs one timeout, not one per entry.
    if (this.relayStalled) {
      throw new Error(`could not check ${entry.path} before removing it`)
    }
    const { expired, cancel } = expireAfter(ROLLBACK_LSTAT_TIMEOUT_MS)
    const [created, current] = await Promise.all([
      entry.identity,
      Promise.race([this.provider.lstat(entry.path), expired]).finally(cancel)
    ])
    if (!current) {
      this.relayStalled = true
      throw new Error(`could not check ${entry.path} before removing it`)
    }
    // Why: a host that reports inodes but whose identity read failed is unverifiable, not a
    // licence to fall back to the size check; only an old relay without inodes falls back.
    const identityUnknown = current.ino !== undefined && created?.ino === undefined
    const changed =
      identityUnknown ||
      current.type !== entry.kind ||
      (entry.kind === 'file' && current.size > entry.maxBytes) ||
      (created?.ino !== undefined &&
        current.ino !== undefined &&
        (created.ino !== current.ino || created.dev !== current.dev))
    if (changed) {
      throw new Error(`${entry.path} changed after this upload created it`)
    }
  }

  private async remove(entry: CreatedRemoteEntry): Promise<void> {
    await this.assertStillOurs(entry)
    if (this.session.removeCreatedEntry) {
      await this.session.removeCreatedEntry(entry.path, entry.kind)
      return
    }
    if (entry.kind === 'directory') {
      // Why: the relay's only directory delete is recursive; keeping the folder is the safe loss.
      throw new Error('No non-recursive directory removal on this transport')
    }
    await this.provider.deletePath(entry.path, false)
  }
}

/**
 * The provider the import runs against: it records the directories it creates, and
 * turns the import's own recursive failure cleanup into the ledger's exact rollback.
 */
export function createLedgerTrackedProvider(
  provider: IFilesystemProvider,
  ledger: SshImportCreatedLedger
): IFilesystemProvider {
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'createDirNoClobber') {
        return async (dirPath: string): Promise<void> => {
          await target.createDirNoClobber(dirPath)
          ledger.record(dirPath, 'directory', 0)
        }
      }
      if (property === 'deletePath') {
        return async (targetPath: string, recursive?: boolean): Promise<void> =>
          recursive ? ledger.rollback() : target.deletePath(targetPath, recursive)
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
