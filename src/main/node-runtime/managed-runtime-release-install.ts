// Verify/start in staging, then publish by rename; commit precedes cleanup so later failures cannot undo installation.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm, statfs } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ManagedRuntimeOperation } from '../../shared/managed-runtime-install'
import { getMainHttpClient, type MainHttpClient } from '../network/http-client'
import {
  resolveInstalledRuntimeRelease,
  RUNTIME_RELEASE_RECEIPT,
  writeRuntimeReleaseReceipt,
  type ManagedRuntime,
  type ManagedRuntimePin
} from './managed-runtime-release'
import { verifyFileSha256 } from './pinned-runtime-materializer'
import { extractPinnedZipMembers } from './pinned-zip-members'
import {
  downloadFailureMessage,
  downloadVerifiedArchive,
  RUNTIME_ARCHIVE_RETRY_DELAYS_MS
} from './runtime-archive-download'

const FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 250

export type RuntimeReleaseInstall = {
  agent: string
  runtime: Pick<ManagedRuntime, 'label' | 'validate'>
  root: string
  pin: ManagedRuntimePin
  fetcher?: MainHttpClient['fetch']
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
    publish({ phase: 'verifying' })
    const whole = await verifyMembers(folder, pin, label, signal).then(
      () => true,
      (error: unknown) => {
        signal.throwIfAborted()
        console.warn(`[managed-runtime] ${agent} copy is damaged; repairing:`, error)
        return false
      }
    )
    if (whole) {
      await validate(input, folder)
      signal.throwIfAborted()
      if (!resolveInstalledRuntimeRelease(root, pin).release?.current) {
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
  const needed = pin.members.reduce((sum, m) => sum + m.bytes, pin.archiveBytes)
  if (space && space.bavail * space.bsize < needed + FREE_SPACE_MARGIN_BYTES) {
    const megabytes = Math.ceil((needed + FREE_SPACE_MARGIN_BYTES) / 1024 ** 2)
    throw new Error(`${label} needs ${megabytes} MB of free disk space to install.`)
  }
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
        archiveSha256: pin.archiveSha256,
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
    ).catch((error: unknown) => {
      if (signal.aborted) {
        throw error
      }
      console.warn(`[managed-runtime] ${agent} download failed:`, error)
      throw new Error(downloadFailureMessage(label, error), { cause: error })
    })
    publish({ phase: 'extracting', downloadedBytes: pin.archiveBytes })
    await extractPinnedZipMembers(archive, release, pin.members, label, signal)
    publish({ phase: 'verifying' })
    await verifyMembers(release, pin, label, signal)
    await validate(input, release)
    await writeRuntimeReleaseReceipt(release, pin)
    signal.throwIfAborted()
    if (existsSync(folder)) {
      await rename(folder, join(staging, 'damaged'))
    }
    await rename(release, folder)
    input.commit()
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
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
    throw new Error(
      `${runtime.label} couldn't start on this host, so it wasn't installed. This host may not support it.`,
      { cause: error }
    )
  })
}

async function verifyMembers(
  root: string,
  pin: ManagedRuntimePin,
  label: string,
  signal: AbortSignal
): Promise<void> {
  for (const member of pin.members) {
    const path = join(root, ...member.path.split('/'))
    await verifyFileSha256(path, member.sha256, `${label} ${member.path}`, signal)
    if (process.platform !== 'win32') {
      await chmod(path, 0o755)
    }
  }
}
