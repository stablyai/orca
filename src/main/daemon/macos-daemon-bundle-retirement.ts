import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { rm } from '../asar-transparent-fs'
import { macDaemonCopyBundlePath } from './macos-daemon-bundle'

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
let collectionInFlight: Promise<void> | null = null

/** Delete only after a complete lsof scan reports no users. */
export async function retireUnusedMacDaemonCopy(directory: string): Promise<void> {
  try {
    const result = await runProcess({
      program: '/usr/sbin/lsof',
      args: ['-F', 'p', '+D', directory],
      timeoutMs: 5_000,
      maxOutputBytes: 8192
    })
    // lsof may exit 1 with live users; require empty output and a complete scan before deletion.
    const unused =
      result.stdout.trim() === '' &&
      result.stderr.trim() === '' &&
      result.code === 1 &&
      !result.timedOut &&
      !result.outputTruncated
    if (!unused) {
      return
    }
    // Direct execution may register this copy with LaunchServices.
    await runProcess({
      program: LSREGISTER,
      args: ['-u', macDaemonCopyBundlePath(directory)],
      timeoutMs: 5_000,
      maxOutputBytes: 8192
    }).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  } catch {
    // Retain code when its use cannot be verified.
  }
}

async function collect(root: string, current: string): Promise<void> {
  const names = await readdir(root).catch(() => [])
  for (const name of names) {
    const directory = join(root, name)
    // This process may still be copying its own staging directories.
    if (directory !== current && !name.includes(`.staging-${process.pid}-`)) {
      await retireUnusedMacDaemonCopy(directory)
    }
  }
}

/** Coalesce background collection across simultaneous terminal launches. */
export function retireOtherMacDaemonCopies(root: string, current: string): Promise<void> {
  collectionInFlight ??= collect(root, current).finally(() => {
    collectionInFlight = null
  })
  return collectionInFlight
}
