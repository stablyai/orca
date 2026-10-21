import { basename } from 'node:path'
import { runProcess } from '@orca/process-host'
import { rm } from './asar-transparent-fs'

/**
 * Copies `source` to `destination`, whose parent must exist, keeping symlinks as links. One
 * `/bin/cp` per tree is several times faster than Node's file-by-file `fs.cp` on APFS.
 */
export async function cloneMacTree(
  source: string,
  destination: string,
  signal?: AbortSignal
): Promise<void> {
  // APFS clone first; a failed clone can leave a partial tree on other filesystems.
  // Clearing also keeps `cp -R` from nesting `source` inside an existing `destination`.
  for (const flags of ['-cR', '-R']) {
    await rm(destination, { recursive: true, force: true })
    // Why no timeout: a large tree at background I/O priority can outlast the 30 s default.
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
