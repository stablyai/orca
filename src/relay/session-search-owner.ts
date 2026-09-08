import { existsSync, mkdirSync, statSync, closeSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import Database from '../main/sqlite/sync-database'
import { hardenSecurePath } from '../shared/secure-file'
import { restrictWindowsPathSync } from '../shared/secure-path-windows-acl'
import {
  SessionSearchService,
  type SessionSearchScanRoots
} from '../main/ai-vault-search/session-search-service'
import { sessionSearchCapability } from '../main/ai-vault-search/session-search-capability'
import {
  DEFAULT_AI_VAULT_SEARCH_SETTINGS,
  type AiVaultSearchSettings,
  type AiVaultSearchIndexStatus
} from '../shared/ai-vault-search-settings'
import {
  SessionSearchConfigureSchema,
  SessionSearchQuerySchema,
  type SessionSearchConfigure,
  type SessionSearchOperation
} from '../shared/ai-vault-search-contract'
import {
  assertOwnedSearchPath,
  readSessionSearchOwnerPolicy,
  writeSessionSearchOwnerPolicy,
  SESSION_SEARCH_POLICY_RECOVERY_HINT
} from './session-search-owner-policy-file'
import { throwIfSignalAborted } from '../shared/abort-signal-reason'
import { projectSessionSearchResult } from '../shared/ai-vault-search-projection'

/** Account-local ownership; SQLite releases the exclusion lock even after a child crash. */
export class RelaySessionSearchOwner {
  private service: SessionSearchService | null = null
  private lock: Database | null = null
  private policy: AiVaultSearchSettings = DEFAULT_AI_VAULT_SEARCH_SETTINGS
  private chain: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private disposed = false
  private applicationError: string | undefined
  private policyError: string | undefined
  private readonly directory: string
  private readonly roots: SessionSearchScanRoots

  constructor(
    private readonly home: string,
    options: { directory?: string; roots?: SessionSearchScanRoots } = {}
  ) {
    if (!options.roots && home !== homedir()) {
      throw new Error('Search source home does not match the relay account.')
    }
    this.directory = options.directory ?? join(home, '.orca', 'session-search-relay')
    this.roots = options.roots ?? {
      wslHomeDirs: [],
      additionalCodexSessionsDirs: [
        join(home, '.local', 'share', 'orca', 'codex-runtime-home', 'home', 'sessions')
      ]
    }
  }

  request(operation: SessionSearchOperation, raw: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.serialize(async () => {
      throwIfSignalAborted(signal)
      if (this.disposed) {
        throw new Error('Search owner is closed.')
      }
      // Validate before acquiring: a rejected `--since` must not close a warm
      // service and drop the exclusion lock the next query would have to retake.
      const configureArgs =
        operation === 'configure' ? SessionSearchConfigureSchema.parse(raw) : undefined
      const query = operation === 'query' ? SessionSearchQuerySchema.parse(raw) : undefined
      const capability = sessionSearchCapability()
      if (operation === 'status' && !this.lock) {
        this.policy = this.readRecordedPolicy()
        // An existing owner's effective policy is only observable while holding the lock.
        if (!existsSync(join(this.directory, 'owner.sqlite'))) {
          return this.status(capability.available, capability.reason)
        }
      }
      if (!capability.available) {
        if (operation === 'status') {
          return this.status(false, capability.reason)
        }
        throw new Error(capability.reason)
      }
      this.acquire()
      try {
        if (operation === 'status') {
          return this.status(true)
        }
        // A policy this host cannot vouch for may cover different sources, so the
        // only operation it still permits is the clear that resets it.
        if (this.policyError && !configureArgs?.clearIndex) {
          throw new Error(`${this.policyError} ${SESSION_SEARCH_POLICY_RECOVERY_HINT}`)
        }
        if (configureArgs) {
          await this.configure(configureArgs)
          return this.status(true)
        }
        this.service ??= this.createService()
        const result = await this.service.search(query!, this.roots, signal)
        return projectSessionSearchResult(result)
      } catch (error) {
        // Why: a caller's cancellation says nothing about the index. Only a
        // failure from the service itself makes this owner's state suspect
        // enough to be worth a reacquire and a policy reread.
        if (!signal?.aborted) {
          await this.release()
        }
        throw error
      }
    })
  }

  private get databasePath(): string {
    return join(this.directory, 'index.sqlite')
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.catch(() => undefined).then(run)
    this.chain = result
    return result
  }

  /**
   * Records an unreadable policy instead of throwing, so `--index-status` — the
   * one command a user would run to diagnose it — still answers.
   */
  private readRecordedPolicy(): AiVaultSearchSettings {
    try {
      const policy = readSessionSearchOwnerPolicy(this.directory, this.home)
      this.policyError = undefined
      return policy
    } catch (error) {
      this.policyError = error instanceof Error ? error.message : 'Search policy is unreadable.'
      return { ...DEFAULT_AI_VAULT_SEARCH_SETTINGS }
    }
  }

  private acquire(): void {
    if (this.lock) {
      return
    }
    if (existsSync(dirname(this.directory))) {
      assertOwnedSearchPath(dirname(this.directory), true)
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    assertOwnedSearchPath(this.directory, true)
    if (process.platform === 'win32') {
      if (!restrictWindowsPathSync(this.directory, true)) {
        throw new Error('Could not secure the host search directory.')
      }
    } else {
      hardenSecurePath(this.directory, {
        isDirectory: true,
        platform: process.platform,
        sync: true
      })
    }
    const path = join(this.directory, 'owner.sqlite')
    try {
      closeSync(openSync(path, 'wx', 0o600))
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    }
    assertOwnedSearchPath(path, false)
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = `${this.databasePath}${suffix}`
      if (existsSync(file)) {
        assertOwnedSearchPath(file, false)
      }
    }
    const lock = new Database(path, { timeout: 0 })
    try {
      lock.exec('BEGIN EXCLUSIVE')
    } catch {
      lock.close()
      throw new Error(
        'Search index is in use by another relay. Retry after its current indexing pass completes.'
      )
    }
    this.lock = lock
    this.policy = this.readRecordedPolicy()
    // Do not extend on traffic: a newer relay generation must get a chance to
    // acquire. The one exception is an active backfill pass — yieldBackfill
    // waits for it rather than restarting discovery on the replacement, and
    // hands the lease over as soon as that pass ends, however it ends.
    this.timer = setTimeout(() => {
      void this.serialize(() => this.yieldBackfill()).catch(() => undefined)
    }, 5_000)
    this.timer.unref?.()
  }

  private async configure(args: SessionSearchConfigure): Promise<void> {
    const next: AiVaultSearchSettings = {
      enabled: args.enabled ?? this.policy.enabled,
      historyDays: args.historyDays === undefined ? this.policy.historyDays : args.historyDays,
      ...((args.paused ?? this.policy.paused) ? { paused: true } : {})
    }
    try {
      // Persist before applying: consent that is not durable must never be the
      // thing an index was built under, so a crash between the two can only ever
      // leave a recorded policy whose apply is retried, not an index nobody
      // consented to on the next start.
      writeSessionSearchOwnerPolicy(this.directory, this.home, next)
      this.policy = next
      this.policyError = undefined
      // Configuration must remain usable even when the existing index cannot be opened.
      this.service ??= this.createService(false)
      await this.service.configure(next, this.roots, { clearIndex: args.clearIndex })
      this.applicationError = undefined
    } catch (error) {
      this.applicationError =
        error instanceof Error ? error.message : 'Search configuration failed.'
      throw error
    }
  }

  private createService(enabled = this.policy.enabled): SessionSearchService {
    try {
      const service = new SessionSearchService({
        databasePath: this.databasePath,
        ...this.policy,
        enabled
      })
      this.applicationError = undefined
      return service
    } catch (error) {
      this.applicationError =
        error instanceof Error ? error.message : 'Search initialization failed.'
      throw error
    }
  }

  private status(available: boolean, reason?: string): AiVaultSearchIndexStatus {
    let indexSizeBytes: number | null = null
    if (existsSync(this.databasePath)) {
      indexSizeBytes = ['', '-wal', '-shm', '-journal'].reduce((bytes, suffix) => {
        try {
          return bytes + statSync(`${this.databasePath}${suffix}`).size
        } catch {
          return bytes
        }
      }, 0)
    }
    const failure =
      this.applicationError ??
      (this.policyError && `${this.policyError} ${SESSION_SEARCH_POLICY_RECOVERY_HINT}`)
    return {
      ...this.policy,
      available,
      applied: available && !failure,
      indexSizeBytes,
      ...((reason ?? failure) ? { reason: reason ?? failure } : {})
    }
  }

  private async release(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    try {
      await this.service?.close()
    } finally {
      this.service = null
      this.lock?.close()
      this.lock = null
    }
  }

  private async yieldBackfill(): Promise<void> {
    const service = this.service
    if (service?.coverage().backfill === 'running') {
      // Finish discovery and parsing before handoff; restarting either can starve large histories.
      void service
        .ensureBackfill(this.roots)
        .then(
          () =>
            this.serialize(async () => {
              if (this.service === service) {
                await this.yieldBackfill()
              }
            }),
          // A pass that cannot finish is no reason to keep the replacement out.
          () =>
            this.serialize(async () => {
              if (this.service === service) {
                await this.release()
              }
            })
        )
        .catch(() => undefined)
      return
    }
    await this.release()
  }

  async close(): Promise<void> {
    this.disposed = true
    await this.serialize(() => this.release())
  }
}
