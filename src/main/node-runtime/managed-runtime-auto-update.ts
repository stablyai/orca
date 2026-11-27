// When Orca brings its own copy of a pinned runtime up to date without a click, and how often it
// tries. The record outlives the host process: a host that restarts often (orcad idle-exits) must
// not download a release again on every start after it failed or was cancelled.

import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import {
  compareAppVersions,
  isValidAppVersion
} from '../../shared/app-lifecycle/identity/app-version'
import type { ManagedRuntimeOperation } from '../../shared/agent-launch/installation/managed-runtime-install'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { renameFileWithWindowsRetryAsync } from '../../shared/file-write/windows-retry-file-operations'
import { runtimeReleaseId, type ManagedRuntimePin } from './managed-runtime-release'

/** Automatic attempts per release; after that only Update fetches it. */
export const MAX_AUTOMATIC_ATTEMPTS = 3
const RETRY_MS = 60 * 60_000
const RECORD_MAX_BYTES = 4 * 1024

const recordSchema = lazyZodSchema(() =>
  z.object({
    releaseId: z.string().min(1),
    attempts: z.number().int().nonnegative(),
    lastAt: z.number().finite().nonnegative(),
    declined: z.boolean()
  })
)
type AutoUpdateRecord = z.infer<typeof recordSchema>

/** What launches run now, as status reports it. */
export type InstalledRelease = { installedVersion: string | null; installedCurrent: boolean }

/** How an install of the pin ended, for the record. */
export type InstallOutcome = Pick<ManagedRuntimeOperation, 'kind' | 'phase'> & {
  /** Started by the automatic check, whose attempt is already counted. */
  automatic: boolean
  /** Stopped because automatic updates were turned off, which is not declining it. */
  stoppedBySwitch: boolean
  /** A failure that will recur (checksum, probe), so no automatic attempt follows. */
  finalFailure: boolean
}

/** Beside the release root, never in it: launch reclaim deletes every name in the root it doesn't keep. */
export function autoUpdateRecordFile(root: string): string {
  return join(dirname(root), `.${basename(root)}-auto-update.json`)
}

/** The pinned release, when it is newer than the whole copy launches run; never a first install,
 *  a downgrade, or a damaged or republished copy of the same version, which Update repairs. */
export function pinnedReleaseAhead(
  pin: ManagedRuntimePin | null,
  { installedVersion, installedCurrent }: InstalledRelease
): string | null {
  if (!pin || installedVersion === null || installedCurrent) {
    return null
  }
  const newer =
    isValidAppVersion(pin.version) &&
    isValidAppVersion(installedVersion) &&
    compareAppVersions(pin.version, installedVersion) > 0
  return newer ? pin.version : null
}

/** At most three automatic attempts per pinned release, an hour then two apart, kept on disk across
 *  starts; a failure that will recur ends them at once, and a Cancel of any install of that release
 *  declines it until Orca pins another. */
export class PinnedRuntimeAutoUpdate {
  /** undefined until read; then the record in memory, which disk follows. */
  private record: AutoUpdateRecord | null | undefined = undefined
  private loading: Promise<void> | null = null
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** Whether `pin` should be fetched now. A due attempt starts only once its record is on disk, so
   *  a record that can't be written stops automatic attempts rather than its cap. */
  async take(pin: ManagedRuntimePin, installed: InstalledRelease): Promise<boolean> {
    if (pinnedReleaseAhead(pin, installed) === null) {
      return false
    }
    const last = await this.recordFor(pin)
    const now = Date.now()
    if (last && (last.declined || last.attempts >= MAX_AUTOMATIC_ATTEMPTS)) {
      return false
    }
    if (last && last.attempts > 0) {
      // A clock that was ahead must not hold updates back for as long as it was ahead.
      if (last.lastAt > now) {
        await this.save({ ...last, lastAt: now })
        return false
      }
      if (now - last.lastAt < RETRY_MS * 2 ** (last.attempts - 1)) {
        return false
      }
    }
    return this.save({
      releaseId: runtimeReleaseId(pin),
      attempts: (last?.attempts ?? 0) + 1,
      lastAt: now,
      declined: false
    })
  }

  /** Whether the record still allows a first automatic attempt at `pin`. */
  async firstAttemptDue(pin: ManagedRuntimePin | null, installed: InstalledRelease) {
    if (!pin || pinnedReleaseAhead(pin, installed) === null) {
      return false
    }
    const last = await this.recordFor(pin)
    return !last || (last.attempts === 0 && !last.declined)
  }

  /** Records how an install of the pin ended. In memory at once when the record is loaded, so a
   *  status read right after the outcome is published already sees it. */
  settled(pin: ManagedRuntimePin | null, outcome: InstallOutcome): Promise<void> {
    if (!pin || outcome.kind !== 'install') {
      return Promise.resolve()
    }
    const apply = (): Promise<unknown> => {
      const last = this.current(pin)
      const base = last ?? {
        releaseId: runtimeReleaseId(pin),
        attempts: 0,
        lastAt: 0,
        declined: false
      }
      if (outcome.phase === 'cancelled' && !outcome.stoppedBySwitch) {
        return this.save({ ...base, declined: true })
      }
      if (outcome.phase === 'failed' && (outcome.finalFailure || !outcome.automatic)) {
        const attempts = outcome.finalFailure ? MAX_AUTOMATIC_ATTEMPTS : base.attempts + 1
        return this.save({
          ...base,
          attempts: Math.max(base.attempts, attempts),
          lastAt: Date.now()
        })
      }
      return Promise.resolve()
    }
    return (this.record === undefined ? this.load().then(apply) : apply()).then(() => undefined)
  }

  /** Removing the runtime forgets its record. */
  forget(): Promise<void> {
    this.record = null
    const removal = this.writes.then(() => rm(this.file, { force: true }))
    this.writes = removal.catch(() => undefined)
    return removal
  }

  private current(pin: ManagedRuntimePin): AutoUpdateRecord | null {
    return this.record?.releaseId === runtimeReleaseId(pin) ? this.record : null
  }

  /** The record for this exact release; one for an earlier pin says nothing about it. */
  private async recordFor(pin: ManagedRuntimePin): Promise<AutoUpdateRecord | null> {
    if (this.record === undefined) {
      await this.load()
    }
    return this.current(pin)
  }

  private load(): Promise<void> {
    this.loading ??= this.read().then((record) => {
      this.record ??= record
    })
    return this.loading
  }

  private async read(): Promise<AutoUpdateRecord | null> {
    await this.sweepTemporaries()
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed =
        text.length <= RECORD_MAX_BYTES ? recordSchema.safeParse(JSON.parse(text)) : null
      return parsed?.success ? parsed.data : null
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        console.warn('[managed-runtime] automatic update record unreadable:', error)
      }
      return null
    }
  }

  /** A write a crash interrupted leaves a temporary beside the record; one writer per userData. */
  private async sweepTemporaries(): Promise<void> {
    const prefix = `${basename(this.file)}.`
    const names = await readdir(dirname(this.file)).catch(() => [])
    await Promise.all(
      names
        .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
        .map((name) => rm(join(dirname(this.file), name), { force: true }).catch(() => undefined))
    )
  }

  /** Written whole and renamed (retrying the locks Windows scanners hold), so a crash never leaves
   *  half a record. Resolves whether it reached disk; memory keeps it either way. */
  private save(record: AutoUpdateRecord): Promise<boolean> {
    this.record = record
    const write = this.writes.then(async () => {
      const temporary = `${this.file}.${process.pid}-${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
        await renameFileWithWindowsRetryAsync(temporary, this.file)
        return true
      } catch (error) {
        console.warn('[managed-runtime] automatic update record not saved:', error)
        await rm(temporary, { force: true }).catch(() => undefined)
        return false
      }
    })
    this.writes = write
    return write
  }
}
