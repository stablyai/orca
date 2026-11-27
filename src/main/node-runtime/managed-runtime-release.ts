// Launch reads use receipts and member sizes; full hashing belongs to installation.

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs'
import { lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import type { ProviderProcessExit } from '../provider-process/managed-provider-process'
import type { ArchiveDigest } from './runtime-archive-download'

export type ManagedRuntimeMember = { path: string; sha256: string; bytes: number }

export type ManagedRuntimePin = {
  version: string
  url: string
  archiveBytes: number
} & ArchiveDigest &
  (
    | {
        /** `file`: the download is the single member itself, not a zip. */
        format?: 'zip' | 'file'
        members: readonly ManagedRuntimeMember[]
      }
    | {
        /** Only the archive's hash is published; it vouches for every file, and these must be executable.
         *  `file`: the download is the one executable itself. */
        format: 'tar.gz' | 'zip' | 'file'
        executables: readonly string[]
      }
  )

export type ManagedRuntime = {
  label: string
  root(dataDirectory: string): string
  pin(): ManagedRuntimePin | null
  /** Runtimes that follow a published latest release look it up here; pin() answers from it. */
  refreshPin?(signal?: AbortSignal): Promise<void>
  /** An installed copy older than pin() is brought up to it without a click, as this build ships it. */
  updatesToPin?: true
  /** Validate startup without user credentials before publishing/reusing this pinned copy. */
  validate?(folder: string, pin: ManagedRuntimePin, signal: AbortSignal): Promise<void>
  /** Add files the unpacked release needs before it is checked and published, e.g. a second command name. */
  prepare?(folder: string, pin: ManagedRuntimePin): Promise<void>
}

/** A managed runtime that is an agent CLI, and where its command sits in a release. */
export type ManagedAgentCli = {
  runtime: ManagedRuntime
  /** Whether this host has a build to download. */
  available: () => boolean
  executable: (folder: string) => string
  /** The one stock command it stands in for, when the agent's launches name other programs too. */
  standsInFor?: string
}

const serverUseListeners = new Set<(agent: string) => void>()
/** Told each time a chat starts on Orca's installed server, so an update that failed is retried on use. */
export function onManagedServerUse(listener: (agent: string) => void): () => void {
  serverUseListeners.add(listener)
  return () => serverUseListeners.delete(listener)
}
/** A launch resolved to `version` of Orca's `runtime`; only runtimes that follow their pin listen. */
export function noteManagedServerUse(
  agent: string,
  runtime: ManagedRuntime | undefined,
  version: string | undefined
): void {
  if (version !== undefined && runtime?.updatesToPin) {
    serverUseListeners.forEach((listener) => listener(agent))
  }
}

/** The download's digest names the release, so a republished build is never mistaken for it. */
export function runtimeReleaseId(pin: ArchiveDigest): string {
  return 'archiveSha512' in pin ? pin.archiveSha512 : pin.archiveSha256
}

/** What a failed start check observed; the installer words it for the user. */
export type ManagedRuntimeStartFailure =
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'exit'; exit: ProviderProcessExit; stderr: string }
  | { kind: 'version'; answered: string; expected: string }

export class ManagedRuntimeStartError extends Error {
  constructor(
    message: string,
    readonly failure: ManagedRuntimeStartFailure | null,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ManagedRuntimeStartError'
  }
}

export const RUNTIME_RELEASE_RECEIPT = '.install-complete.json'
const RECEIPT_MAX_BYTES = 8 * 1024
const VERSION_ORDER = new Intl.Collator(undefined, { numeric: true })

const runtimeReleaseReceiptSchema = lazyZodSchema(() =>
  z.object({
    releaseId: z.string().regex(/^[a-f0-9]{64}(?:[a-f0-9]{64})?$/),
    version: z.string().min(1),
    platform: z.string(),
    arch: z.string(),
    members: z
      .array(z.object({ path: z.string().min(1), bytes: z.number().int().positive() }))
      .min(1)
  })
)

export type InstalledRuntimeRelease = {
  folder: string
  version: string
  current: boolean
}

type ReleaseRead = { releaseId: string; version: string } | 'broken' | 'unreadable'

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
    (release) => release.name === pin?.version && release.releaseId === runtimeReleaseId(pin)
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

/** Whether `root` may hold a published release; an unreadable one may, so callers fail closed. */
export async function runtimeReleaseMayBePublished(root: string): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    return !isDefinitiveAbsence(error)
  }
  const receipts = await Promise.all(
    names
      .filter((name) => !name.startsWith('.'))
      .map((name) =>
        lstat(join(root, name, RUNTIME_RELEASE_RECEIPT)).then(
          (receipt) => receipt.isFile(),
          (error: unknown) => !isDefinitiveAbsence(error)
        )
      )
  )
  return receipts.some(Boolean)
}

/** Require every pinned companion beside the resolved executable; never launch an isolated server file. */
export function copyBesidePinnedMembers(
  command: string,
  pin: ManagedRuntimePin | null
): string | null {
  try {
    const real = realpathSync(command)
    const members = pin && 'members' in pin ? pin.members : []
    const whole = members.every((member) => {
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
    releaseId: runtimeReleaseId(pin),
    version: pin.version,
    platform: process.platform,
    arch: process.arch,
    members: await receiptMembers(folder, pin)
  }
  await writeFile(join(folder, RUNTIME_RELEASE_RECEIPT), JSON.stringify(receipt), { flag: 'wx' })
}

// An archive without published member hashes records the sizes its executables extracted to.
async function receiptMembers(
  folder: string,
  pin: ManagedRuntimePin
): Promise<{ path: string; bytes: number }[]> {
  if ('members' in pin) {
    return pin.members.map(({ path, bytes }) => ({ path, bytes }))
  }
  return Promise.all(
    pin.executables.map(async (path) => ({
      path,
      bytes: (await lstat(join(folder, ...path.split('/')))).size
    }))
  )
}

/** Exclusive writer only: keep must match launch resolution so reclamation cannot remove a running release. */
export async function reclaimRuntimeReleases(
  root: string,
  keep: readonly string[]
): Promise<string[]> {
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? [] : Promise.reject(error)
  )
  const stale = names.filter((name) => !keep.includes(name))
  const results = await Promise.allSettled(
    stale.map(async (name) => {
      const path = join(root, name)
      if (name.startsWith('.download-') && (await hasUnreplacedRuntime(path, root, keep))) {
        throw new Error(`Previous runtime release is still kept at ${join(path, 'damaged')}`)
      }
      await rm(path, { recursive: true, force: true })
    })
  )
  return stale.filter((_, index) => results[index]?.status === 'rejected')
}

async function hasUnreplacedRuntime(
  staging: string,
  root: string,
  keep: readonly string[]
): Promise<boolean> {
  const damaged = join(staging, 'damaged')
  try {
    await lstat(damaged)
  } catch (error) {
    return !isDefinitiveAbsence(error)
  }
  // Failed repair backups become stale only once a whole replacement is published.
  const previous = await readReleaseReceipt(damaged)
  if (typeof previous !== 'object' || !keep.includes(previous.version)) {
    return true
  }
  const folder = join(root, previous.version)
  const replacement = await readReleaseReceipt(folder, previous.version)
  if (typeof replacement !== 'object') {
    return true
  }
  try {
    for (const member of replacement.members) {
      if (
        !isWholeRuntimeMember(await lstat(join(folder, ...member.path.split('/'))), member.bytes)
      ) {
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

function readRelease(folder: string, version?: string): ReleaseRead {
  try {
    const receiptPath = join(folder, RUNTIME_RELEASE_RECEIPT)
    const stat = lstatSync(receiptPath)
    if (!lstatSync(folder).isDirectory() || !stat.isFile() || stat.size > RECEIPT_MAX_BYTES) {
      return 'broken'
    }
    const receipt = parseReleaseReceipt(readFileSync(receiptPath, 'utf8'), version)
    const whole = receipt?.members.every((member) =>
      isWholeRuntimeMember(lstatSync(join(folder, ...member.path.split('/'))), member.bytes)
    )
    return whole && receipt ? { releaseId: receipt.releaseId, version: receipt.version } : 'broken'
  } catch (error) {
    return isDefinitiveAbsence(error) ? 'broken' : 'unreadable'
  }
}

async function readReleaseReceipt(
  folder: string,
  version?: string
): Promise<z.infer<typeof runtimeReleaseReceiptSchema> | 'broken' | 'unreadable'> {
  try {
    const receiptPath = join(folder, RUNTIME_RELEASE_RECEIPT)
    const [directory, receipt] = await Promise.all([lstat(folder), lstat(receiptPath)])
    if (!directory.isDirectory() || !receipt.isFile() || receipt.size > RECEIPT_MAX_BYTES) {
      return 'broken'
    }
    return parseReleaseReceipt(await readFile(receiptPath, 'utf8'), version) ?? 'broken'
  } catch (error) {
    return isDefinitiveAbsence(error) ? 'broken' : 'unreadable'
  }
}

function parseReleaseReceipt(
  text: string,
  version?: string
): z.infer<typeof runtimeReleaseReceiptSchema> | null {
  const receipt = runtimeReleaseReceiptSchema.safeParse(parseJson(text))
  const valid =
    receipt.success &&
    (version === undefined || receipt.data.version === version) &&
    receipt.data.platform === process.platform &&
    receipt.data.arch === process.arch &&
    receipt.data.members.every((member) => {
      const segments = member.path.split('/')
      return !segments.some((segment) => !segment || segment === '.' || segment === '..')
    })
  return valid ? receipt.data : null
}

function isWholeRuntimeMember(file: Stats, bytes: number): boolean {
  return (
    file.isFile() &&
    file.size === bytes &&
    (process.platform === 'win32' || (file.mode & 0o111) !== 0)
  )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
