import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { rm } from '../asar-transparent-fs'
import { macDaemonCopyBundlePath } from './macos-daemon-bundle'

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
let collectionInFlight: Promise<void> | null = null

/** Deletes a copy unless any process still has a file in it open, mapped or as its executable. */
export async function retireUnusedMacDaemonCopy(directory: string): Promise<void> {
  try {
    const result = await runProcess({
      program: '/usr/sbin/lsof',
      args: ['-F', 'p', '+D', directory],
      timeoutMs: 5_000,
      maxOutputBytes: 8192
    })
    // `lsof +D` exits 1 even when it lists users (any closed file in the tree does that), so only
    // empty stdout proves the copy unused; the remaining checks reject an incomplete scan.
    const unused =
      result.stdout.trim() === '' &&
      result.stderr.trim() === '' &&
      result.code === 1 &&
      !result.timedOut &&
      !result.outputTruncated
    if (!unused) {
      return
    }
    // Something that ran the executable directly may have registered the copy with LaunchServices.
    await runProcess({
      program: LSREGISTER,
      args: ['-u', macDaemonCopyBundlePath(directory)],
      timeoutMs: 5_000,
      maxOutputBytes: 8192
    }).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  } catch {
    // Unverifiable use retains code.
  }
}

async function collect(root: string, current: string): Promise<void> {
  const names = await readdir(root).catch(() => [])
  for (const name of names) {
    const directory = join(root, name)
    // Only this process launches, and only from `current`; its own staging may still be copying.
    if (directory !== current && !name.includes(`.staging-${process.pid}-`)) {
      await retireUnusedMacDaemonCopy(directory)
    }
  }
}

/** One background collection at a time, never one scan per terminal. */
export function retireOtherMacDaemonCopies(root: string, current: string): Promise<void> {
  collectionInFlight ??= collect(root, current).finally(() => {
    collectionInFlight = null
  })
  return collectionInFlight
}
