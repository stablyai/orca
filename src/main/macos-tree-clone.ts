import { basename } from 'node:path'
import { runProcess } from '@orca/process-host'
import { rm } from './asar-transparent-fs'

/** Requires an existing destination parent; whole-tree cp avoids Node’s file-by-file APFS overhead. */
export async function cloneMacTree(
  source: string,
  destination: string,
  signal?: AbortSignal
): Promise<void> {
  // Clear partial clones before fallback, and prevent cp -R from nesting into an existing destination.
  for (const flags of ['-cR', '-R']) {
    await rm(destination, { recursive: true, force: true })
    // Large trees copied at background I/O priority can exceed the default timeout.
    const result = await runProcess({
      program: '/bin/cp',
      args: [flags, source, destination],
      timeoutMs: null,
      maxOutputBytes: 8192,
      signal
    })
    if (result.code === 0) {
      return
    }
  }
  throw new Error(`Could not copy ${basename(source)}`)
}
