// Launch reads use receipts and member sizes; full hashing belongs to installation.

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

export type ManagedRuntimePin = {
  version: string
  url: string
  archiveSha256: string
  archiveBytes: number
  members: readonly { path: string; sha256: string; bytes: number }[]
}

export type ManagedRuntime = {
  label: string
  root(dataDirectory: string): string
  pin(): ManagedRuntimePin | null
  /** Validate startup without user credentials before publishing/reusing this pinned copy. */
  validate?(folder: string, pin: ManagedRuntimePin, signal: AbortSignal): Promise<void>
}

export const RUNTIME_RELEASE_RECEIPT = '.install-complete.json'
const RECEIPT_MAX_BYTES = 8 * 1024
const VERSION_ORDER = new Intl.Collator(undefined, { numeric: true })

const runtimeReleaseReceiptSchema = z.object({
  releaseId: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().min(1),
  platform: z.string(),
  arch: z.string(),
  members: z.array(z.object({ path: z.string().min(1), bytes: z.number().int().positive() })).min(1)
})

export type InstalledRuntimeRelease = {
  folder: string
  version: string
  current: boolean
}

type ReleaseRead = { releaseId: string } | 'broken' | 'unreadable'

export type InstalledRuntimeReleases = {
  /** Prefer the whole pinned release, then newest whole fallback; ignore staging, links and partial copies. */
  release: InstalledRuntimeRelease | null
  broken: string[]
  unreadable: boolean
}

export function resolveInstalledRuntimeRelease(
  root: string,
  pin: ManagedRuntimePin | null
): InstalledRuntimeReleases {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch (error) {
    return { release: null, broken: [], unreadable: !isDefinitiveAbsence(error) }
  }
  const reads = names
    .filter((name) => !name.startsWith('.'))
    .map((name) => ({ name, read: readRelease(join(root, name), name) }))
  const releases = reads.flatMap(({ name, read }) =>
    typeof read === 'object' ? [{ name, releaseId: read.releaseId }] : []
  )
  const pinned = releases.find(
    (release) => release.name === pin?.version && release.releaseId === pin.archiveSha256
  )
  const chosen = pinned ?? releases.sort((a, b) => VERSION_ORDER.compare(b.name, a.name))[0]
  return {
    release: chosen
      ? { folder: join(root, chosen.name), version: chosen.name, current: chosen === pinned }
      : null,
    broken: reads.filter(({ read }) => read === 'broken').map(({ name }) => name),
    unreadable: reads.some(({ read }) => read === 'unreadable')
  }
}

/** Require every pinned companion beside the resolved executable; never launch an isolated server file. */
export function copyBesidePinnedMembers(
  command: string,
  pin: ManagedRuntimePin | null
): string | null {
  try {
    const real = realpathSync(command)
    const whole = (pin?.members ?? []).every((member) => {
      const file = statSync(join(dirname(real), basename(member.path)))
      return file.isFile() && (process.platform === 'win32' || (file.mode & 0o111) !== 0)
    })
    return whole ? real : null
  } catch {
    return null
  }
}

/** Write before atomic rename so published releases cannot carry partial receipts. */
export async function writeRuntimeReleaseReceipt(
  folder: string,
  pin: ManagedRuntimePin
): Promise<void> {
  const receipt: z.infer<typeof runtimeReleaseReceiptSchema> = {
    releaseId: pin.archiveSha256,
    version: pin.version,
    platform: process.platform,
    arch: process.arch,
    members: pin.members.map(({ path, bytes }) => ({ path, bytes }))
  }
  await writeFile(join(folder, RUNTIME_RELEASE_RECEIPT), JSON.stringify(receipt), { flag: 'wx' })
}

/** Exclusive writer only: keep must match launch resolution so reclamation cannot remove a running release. */
export async function reclaimRuntimeReleases(root: string, keep: string | null): Promise<string[]> {
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? [] : Promise.reject(error)
  )
  const stale = names.filter((name) => name !== keep)
  const results = await Promise.allSettled(
    stale.map((name) => rm(join(root, name), { recursive: true, force: true }))
  )
  return stale.filter((_, index) => results[index]?.status === 'rejected')
}

function readRelease(folder: string, version: string): ReleaseRead {
  try {
    const receiptPath = join(folder, RUNTIME_RELEASE_RECEIPT)
    const stat = lstatSync(receiptPath)
    if (!lstatSync(folder).isDirectory() || !stat.isFile() || stat.size > RECEIPT_MAX_BYTES) {
      return 'broken'
    }
    const receipt = runtimeReleaseReceiptSchema.safeParse(
      parseJson(readFileSync(receiptPath, 'utf8'))
    )
    const whole =
      receipt.success &&
      receipt.data.version === version &&
      receipt.data.platform === process.platform &&
      receipt.data.arch === process.arch &&
      receipt.data.members.every((member) => {
        const segments = member.path.split('/')
        if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
          return false
        }
        const file = lstatSync(join(folder, ...segments))
        return (
          file.isFile() &&
          file.size === member.bytes &&
          (process.platform === 'win32' || (file.mode & 0o111) !== 0)
        )
      })
    return whole ? { releaseId: receipt.data.releaseId } : 'broken'
  } catch (error) {
    return isDefinitiveAbsence(error) ? 'broken' : 'unreadable'
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
