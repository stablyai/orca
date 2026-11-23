// When Orca brings its own copy of a pinned runtime up to date without a click, and how often it
// tries. The record outlives the host process: a host that restarts often (orcad idle-exits) must
// not download a release again on every start after it failed or was cancelled.

import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import {
  compareAppVersions,
  isValidAppVersion
} from '../../shared/app-lifecycle/identity/app-version'
import type { ManagedRuntimeOperation } from '../../shared/agent-launch/installation/managed-runtime-install'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import {
  runtimeReleaseId,
  type InstalledRuntimeReleases,
  type ManagedRuntimePin
} from './managed-runtime-release'

const RETRY_MS = 60 * 60_000
const MAX_RETRY_MS = 24 * 60 * 60_000
const RECORD_MAX_BYTES = 4 * 1024

const recordSchema = z.object({
  releaseId: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  lastAt: z.number().nonnegative(),
  declined: z.boolean()
})
type AutoUpdateRecord = z.infer<typeof recordSchema>

/** Beside the release root, never in it: launch reclaim deletes every name in the root it doesn't keep. */
export function autoUpdateRecordFile(root: string): string {
  return join(dirname(root), `.${basename(root)}-auto-update.json`)
}

/** The pinned release, when it is newer than the whole copy launches run; never a downgrade, and a
 *  damaged or republished copy of the same version waits for Update, which repairs it. An
 *  unreadable root may already hold the pin, so it waits too. */
export function pinnedReleaseAhead(
  pin: ManagedRuntimePin | null,
  { release, unreadable }: InstalledRuntimeReleases
): string | null {
  if (!pin || !release || release.current || unreadable) {
    return null
  }
  const newer =
    isValidAppVersion(pin.version) &&
    isValidAppVersion(release.version) &&
    compareAppVersions(pin.version, release.version) > 0
  return newer ? pin.version : null
}

/** One attempt per pinned release, then each retry waits twice as long (up to a day); a Cancel of
 *  any install of that release declines it until Orca pins another. Kept on disk across starts. */
export class PinnedRuntimeAutoUpdate {
  private record: Promise<AutoUpdateRecord | null> | null = null
  private writes: Promise<void> = Promise.resolve()
  private automatic: string | null = null

  constructor(private readonly file: string) {}

  /** Whether `pin` should be fetched now; a due attempt is recorded before it starts. */
  async take(pin: ManagedRuntimePin, releases: InstalledRuntimeReleases): Promise<boolean> {
    if (pinnedReleaseAhead(pin, releases) === null) {
      return false
    }
    const last = await this.recordFor(pin)
    if (last) {
      const wait = Math.min(RETRY_MS * 2 ** (last.attempts - 1), MAX_RETRY_MS)
      if (last.declined || (last.attempts > 0 && Date.now() - last.lastAt < wait)) {
        return false
      }
    }
    await this.save({
      releaseId: runtimeReleaseId(pin),
      attempts: (last?.attempts ?? 0) + 1,
      lastAt: Date.now(),
      declined: false
    })
    return true
  }

  /** Whether an update to `pin` will still run without a click: never tried here, never declined.
   *  After a failure Update is the way forward again, so clients offer it. */
  async pending(pin: ManagedRuntimePin | null, releases: InstalledRuntimeReleases) {
    if (!pin || pinnedReleaseAhead(pin, releases) === null) {
      return false
    }
    const last = await this.recordFor(pin)
    return !last || (last.attempts === 0 && !last.declined)
  }

  started(operationId: string): void {
    this.automatic = operationId
  }

  /** The automatic install running now, if any. */
  running(): string | null {
    return this.automatic
  }

  /** Any cancelled install of the pin declines it; one the kill switch stopped does not. */
  async settled(
    pin: ManagedRuntimePin | null,
    operation: Pick<ManagedRuntimeOperation, 'id' | 'kind' | 'phase'>,
    stoppedBySwitch: boolean
  ): Promise<void> {
    if (operation.id === this.automatic) {
      this.automatic = null
    }
    if (
      !pin ||
      operation.kind !== 'install' ||
      operation.phase !== 'cancelled' ||
      stoppedBySwitch
    ) {
      return
    }
    const last = await this.recordFor(pin)
    await this.save({
      releaseId: runtimeReleaseId(pin),
      attempts: last?.attempts ?? 0,
      lastAt: last?.lastAt ?? Date.now(),
      declined: true
    })
  }

  /** The record for this exact release; one for an earlier pin says nothing about it. */
  private async recordFor(pin: ManagedRuntimePin): Promise<AutoUpdateRecord | null> {
    this.record ??= this.read()
    const record = await this.record
    return record?.releaseId === runtimeReleaseId(pin) ? record : null
  }

  private async read(): Promise<AutoUpdateRecord | null> {
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

  /** Written whole and renamed, so a crash never leaves half a record; a failed write only costs
   *  the backoff, never the update. */
  private save(record: AutoUpdateRecord): Promise<void> {
    this.record = Promise.resolve(record)
    const write = this.writes.then(async () => {
      const temporary = `${this.file}.${process.pid}-${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
        await rename(temporary, this.file)
      } catch (error) {
        console.warn('[managed-runtime] automatic update record not saved:', error)
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    })
    this.writes = write
    return write
  }
}
