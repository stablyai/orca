// Verify/start in staging, then publish by rename; commit precedes cleanup so later failures cannot undo installation.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, rename, rm, statfs } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../shared/file-write/windows-retry-file-operations'
import {
  excerptAgentFailureOutput,
  sanitizeAgentFailureDetail,
  stripAnsiControlSequences
} from '../../shared/source-control/ai/generation/commit-message-agent-output'
import type { ManagedRuntimeOperation } from '../../shared/agent-launch/installation/managed-runtime-install'
import { getMainHttpClient, type MainHttpClient } from '../network/http-client'
import { redactString } from '../../shared/observability/redactor'
import {
  resolveInstalledRuntimeRelease,
  ManagedRuntimeStartError,
  RUNTIME_RELEASE_RECEIPT,
  writeRuntimeReleaseReceipt,
  type ManagedRuntime,
  type ManagedRuntimeMember,
  type ManagedRuntimePin,
  type ManagedRuntimeStartFailure
} from './managed-runtime-release'
import { verifyFileSha256 } from './pinned-runtime-materializer'
import { extractPinnedZipMembers } from './pinned-zip-members'
import {
  downloadFailureMessage,
  downloadVerifiedArchive,
  extractRuntimeArchive,
  RUNTIME_ARCHIVE_RETRY_DELAYS_MS
} from './runtime-archive-download'

const FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 250
// Unpacked files aren't listed up front; packages unpack to about three times their download.
const UNPACKED_RATIO = 3
const EXTRACT_TIMEOUT_MS = 10 * 60_000
// Endpoint security can hold a release it just watched run for seconds; back off ~15s on Windows.
async function publishRename(from: string, to: string, signal: AbortSignal): Promise<void> {
  await renameFileWithWindowsRetryAsync(from, to, undefined, { attempts: 25, signal })
}

export type RuntimeReleaseInstall = {
  agent: string
  runtime: Pick<ManagedRuntime, 'label' | 'validate' | 'prepare'>
  root: string
  pin: ManagedRuntimePin
  fetcher?: MainHttpClient['fetch']
  /** An install nobody asked for: it keeps this much free instead of the usual margin, and doesn't
   *  start when free space can't be read. */
  automaticFreeSpaceMarginBytes?: number
  signal: AbortSignal
  publish: (patch: Partial<ManagedRuntimeOperation>) => void
  /** Mark committed immediately after publication, before fallible cleanup. */
  commit: () => void
}

export async function installRuntimeRelease(input: RuntimeReleaseInstall): Promise<void> {
  const { agent, root, pin, signal, publish } = input
  const { label } = input.runtime
  const folder = join(root, pin.version)
  await mkdir(root, { recursive: true })
  if (existsSync(folder)) {
    const receiptCurrent = (): boolean =>
      resolveInstalledRuntimeRelease(root, pin).release?.current === true
    publish({ phase: 'verifying' })
    // Without member hashes, only a receipt for this exact archive proves a copy whole.
    const whole =
      'members' in pin
        ? await verifyMembers(folder, pin, label, signal).then(
            () => true,
            (error: unknown) => {
              signal.throwIfAborted()
              console.warn(`[managed-runtime] ${agent} copy is damaged; repairing:`, error)
              return false
            }
          )
        : receiptCurrent()
    if (whole) {
      await validate(input, folder)
      signal.throwIfAborted()
      if (!receiptCurrent()) {
        // Complete members without a valid receipt need repair to escape damaged status.
        await rm(join(folder, RUNTIME_RELEASE_RECEIPT), { force: true })
        await writeRuntimeReleaseReceipt(folder, pin)
      }
      input.commit()
      return
    }
    publish({ phase: 'downloading' })
  }
  const space = await statfs(root).catch((error: unknown) => {
    console.warn(`[managed-runtime] ${agent} free space unknown; not checked:`, error)
  })
  // A single-file release is renamed into place, so it never needs room for two copies.
  const needed =
    pin.format === 'file'
      ? pin.archiveBytes
      : !('members' in pin)
        ? pin.archiveBytes * (1 + UNPACKED_RATIO)
        : pin.members.reduce((sum, m) => sum + m.bytes, pin.archiveBytes)
  assertFreeSpace(label, space ? space.bavail * space.bsize : null, needed, input)
  const staging = join(root, `.download-${process.pid}-${randomUUID()}`)
  const release = join(staging, 'release')
  try {
    await mkdir(release, { recursive: true })
    const archive = join(staging, basename(new URL(pin.url).pathname))
    let shownAt = 0
    await downloadVerifiedArchive(
      {
        label,
        url: pin.url,
        ...('archiveSha512' in pin
          ? { archiveSha512: pin.archiveSha512 }
          : { archiveSha256: pin.archiveSha256 }),
        maxArchiveBytes: pin.archiveBytes
      },
      archive,
      input.fetcher ?? getMainHttpClient().fetch,
      signal,
      RUNTIME_ARCHIVE_RETRY_DELAYS_MS,
      (bytes) => {
        if (Date.now() - shownAt >= PROGRESS_INTERVAL_MS) {
          shownAt = Date.now()
          publish({ downloadedBytes: bytes })
        }
      }
    ).catch(async (error: unknown) => {
      if (signal.aborted) {
        throw error
      }
      console.warn(`[managed-runtime] ${agent} download failed:`, error)
      // Only a whole archive whose hash differs shows the release itself isn't the pinned one; a
      // portal page, a proxy's error or a cut-off body is another size and may pass next time.
      const whole =
        isChecksumMismatch(error) &&
        (await lstat(archive).then(
          (file) => file.size === pin.archiveBytes,
          () => false
        ))
      const Failure = whole ? ArchiveHashMismatchError : Error
      throw new Failure(downloadFailureMessage(label, error), { cause: error })
    })
    publish({ phase: 'extracting', downloadedBytes: pin.archiveBytes })
    await (pin.format === 'file'
      ? placeOnlyFile(archive, release, 'members' in pin ? pin.members : pin.executables)
      : !('members' in pin)
        ? extractWholeArchive(archive, release, label, signal)
        : extractPinnedZipMembers(archive, release, pin.members, label, signal))
    publish({ phase: 'verifying' })
    // Before the check, so a command prepare unpacks is checked like a downloaded one.
    await input.runtime.prepare?.(release, pin)
    await verifyMembers(release, pin, label, signal)
    await validate(input, release)
    await writeRuntimeReleaseReceipt(release, pin)
    if (existsSync(folder)) {
      await publishRename(folder, join(staging, 'damaged'), signal)
    }
    await publishRename(release, folder, signal)
    input.commit()
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function placeOnlyFile(
  archive: string,
  release: string,
  files: readonly (ManagedRuntimeMember | string)[]
): Promise<void> {
  const [file, ...rest] = files
  const segments = (typeof file === 'string' ? file : file?.path)?.split('/') ?? []
  if (!file || rest.length > 0 || segments.some((s) => !s || s === '.' || s === '..')) {
    throw new Error(`A single-file release needs exactly one member, not ${files.length}.`)
  }
  const path = join(release, ...segments)
  await mkdir(dirname(path), { recursive: true })
  await rename(archive, path)
}

async function extractWholeArchive(
  archive: string,
  release: string,
  label: string,
  signal: AbortSignal
): Promise<void> {
  const result = await extractRuntimeArchive(
    { label },
    archive,
    release,
    signal,
    EXTRACT_TIMEOUT_MS
  )
  signal.throwIfAborted()
  if (result.code !== 0 || result.timedOut) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`Couldn't unpack the ${label} download.${detail ? ` ${detail}` : ''}`)
  }
  // The archive is no longer needed once unpacked; free its space before checking.
  await rm(archive, { force: true })
}

const megabytes = (bytes: number): number => Math.ceil(bytes / 1024 ** 2)

function assertFreeSpace(
  label: string,
  available: number | null,
  needed: number,
  { automaticFreeSpaceMarginBytes: automaticMargin }: RuntimeReleaseInstall
): void {
  const manual = needed + FREE_SPACE_MARGIN_BYTES
  if (automaticMargin === undefined) {
    if (available !== null && available < manual) {
      throw new Error(`${label} needs ${megabytes(manual)} MB of free disk space to install.`)
    }
    return
  }
  if (available === null) {
    throw new Error(
      `Orca couldn't read this host's free disk space, so it didn't update ${label} by itself. Update installs it.`
    )
  }
  const automatic = needed + automaticMargin
  if (available < automatic) {
    throw new Error(
      `Orca updates ${label} by itself only with ${megabytes(automatic)} MB free, and this host has ${megabytes(available)} MB. Update needs ${megabytes(manual)} MB.`
    )
  }
}

/** The whole archive downloaded and its hash isn't the pinned one: the release itself differs. */
class ArchiveHashMismatchError extends Error {}

/** The downloaded release ran in its check and refused to start, or answered as another version. */
class RuntimeStartRefusedError extends Error {
  constructor(
    message: string,
    options: ErrorOptions,
    readonly ranAndRefused: boolean
  ) {
    super(message, options)
  }
}

/** A failure that recurs on every attempt: the whole archive isn't the pinned one, or the release
 *  ran and refused to start on this host. Timeouts, disk, network, HTTP and odd-sized bodies may pass. */
export function isFinalInstallFailure(error: unknown): boolean {
  return (
    error instanceof ArchiveHashMismatchError ||
    (error instanceof RuntimeStartRefusedError && error.ranAndRefused)
  )
}

export function installFailureText(label: string, error: unknown, deadline: AbortSignal): string {
  const message = error instanceof Error ? error.message : String(error)
  if (deadline.aborted) {
    return `Installing ${label} took longer than 45 minutes. Try again.`
  }
  return isChecksumMismatch(error)
    ? `The ${label} download did not match its pinned checksum, so nothing was installed.`
    : message
}

function isChecksumMismatch(error: unknown): boolean {
  return error instanceof Error && /checksum mismatch/.test(error.message)
}

async function validate(input: RuntimeReleaseInstall, folder: string): Promise<void> {
  const { runtime, pin, signal } = input
  await runtime.validate?.(folder, pin, signal).catch((error: unknown) => {
    signal.throwIfAborted()
    console.warn(`[managed-runtime] ${input.agent} did not start from ${folder}:`, error)
    const observed = error instanceof ManagedRuntimeStartError ? error.failure : null
    throw new RuntimeStartRefusedError(
      `${runtime.label} couldn't start on this host, so it wasn't installed. This host may not support it.${observed ? ` ${startFailureText(observed)}` : ''}`,
      { cause: error },
      // It ran: it answered as another version, or a process started and exited on its own.
      observed?.kind === 'version' ||
        (observed?.kind === 'exit' && !observed.exit.processless && !observed.exit.outcomeLost)
    )
  })
}

function startFailureText(failure: ManagedRuntimeStartFailure): string {
  switch (failure.kind) {
    case 'timeout':
      return `It timed out after ${Math.round(failure.timeoutMs / 1000)} seconds.`
    case 'version': {
      const answered = sanitizeAgentFailureDetail(
        redactString(stripAnsiControlSequences(failure.answered))
      )
      return `It answered as version ${answered ?? 'unknown'}, expected ${failure.expected}.`
    }
    case 'exit': {
      const { code, signal } = failure.exit
      const status = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`
      const stderr = redactString(stripAnsiControlSequences(failure.stderr))
      const detail = sanitizeAgentFailureDetail(excerptAgentFailureOutput('', stderr))
      return detail ? `It exited with ${status}: ${detail}` : `It exited with ${status}.`
    }
  }
}

async function verifyMembers(
  root: string,
  pin: ManagedRuntimePin,
  label: string,
  signal: AbortSignal
): Promise<void> {
  if (!('members' in pin)) {
    for (const executable of pin.executables) {
      const path = join(root, ...executable.split('/'))
      const file = await lstat(path).catch(() => null)
      if (!file?.isFile()) {
        throw new Error(`The ${label} download is missing ${executable}.`)
      }
      if (process.platform !== 'win32') {
        await chmod(path, 0o755)
      }
    }
    return
  }
  for (const member of pin.members) {
    const path = join(root, ...member.path.split('/'))
    await verifyFileSha256(path, member.sha256, `${label} ${member.path}`, signal)
    if (process.platform !== 'win32') {
      await chmod(path, 0o755)
    }
  }
}
