import {
  FileTooLargeError,
  readLocalFileBounded
} from '../../filesystem/local-file-io/local-regular-file-read'
import { REX_MAX_SNAPSHOT_BYTES, rexDecoderJobs } from './rex-memory-budget'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { REX_GHOSTTY_SHA256 } from './rex-ghostty-decoder'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type { RexSnapshotDecoder, RexDecodedSnapshot } from './rex-reattach'

const MAX_WASM = 2 * 1024 * 1024
const TIMEOUT = 5000
const workerResult = lazyZodSchema(() =>
  z.object({
    ok: z.literal(true),
    result: z.object({
      ansi: z.string().max(REX_MAX_SNAPSHOT_BYTES),
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(1000),
      continuation: z.instanceof(Uint8Array)
    })
  })
)

async function readArtifact(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_WASM) {
      throw new Error('Invalid Ghostty artifact')
    }
    const artifact = await readLocalFileBounded(file, MAX_WASM, info.size).catch(
      (error: unknown) => {
        if (error instanceof FileTooLargeError) {
          throw new Error('Ghostty artifact too large')
        }
        throw error
      }
    )
    if (createHash('sha256').update(artifact).digest('hex') !== REX_GHOSTTY_SHA256) {
      throw new Error('Unapproved Ghostty WASM artifact')
    }
    return artifact
  } finally {
    await file.close()
  }
}

/** Opt-in path to a verified artifact; no auto-install or network side effects. */
export function createRexSnapshotDecoder(
  wasmPath: string,
  workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    'rex-snapshot-worker-entry.js'
  )
): RexSnapshotDecoder {
  if (!isAbsolute(wasmPath) || !isAbsolute(workerPath)) {
    throw new Error('Absolute Rex decoder paths required')
  }
  let active = false
  const decode: RexSnapshotDecoder = async (snapshot) => {
    if (active || snapshot.length > REX_MAX_SNAPSHOT_BYTES) {
      throw new Error('Rex decoder busy or snapshot too large')
    }
    active = true
    let release: (() => void) | undefined
    try {
      release = await rexDecoderJobs.acquire()
      const wasm = await readArtifact(wasmPath)
      return await new Promise<RexDecodedSnapshot>((resolve, reject) => {
        const worker = spawnWorkerThread(workerPath, {
          name: 'orca-rex-snapshot',
          workerData: { wasm, snapshot },
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 }
        })
        let settled = false
        const timer = setTimeout(() => finish(new Error('Rex snapshot decode timed out')), TIMEOUT)
        function finish(error?: Error, result?: RexDecodedSnapshot): void {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          // Do not release the global worker slot before the worker actually exits.
          void worker.terminate().then(() => {
            if (error || !result) {
              reject(error ?? new Error('Rex decoder failed'))
            } else {
              resolve(result)
            }
          }, reject)
        }
        worker.once('message', (message: unknown) => {
          const parsed = workerResult.safeParse(message)
          if (!parsed.success) {
            finish(new Error('Rex snapshot decode failed'))
            return
          }
          const result = parsed.data.result
          if (
            Buffer.byteLength(result.ansi) > REX_MAX_SNAPSHOT_BYTES ||
            result.continuation.length > 1024 * 1024
          ) {
            finish(new Error('Rex decoded snapshot exceeds limit'))
            return
          }
          finish(undefined, { ...result, continuation: Buffer.from(result.continuation) })
        })
        worker.once('error', () => finish(new Error('Rex snapshot worker failed')))
        worker.once('exit', () => finish(new Error('Rex snapshot worker exited')))
      })
    } finally {
      release?.()
      active = false
    }
  }
  decode.validateArtifact = async () => {
    await readArtifact(wasmPath)
  }
  return decode
}
