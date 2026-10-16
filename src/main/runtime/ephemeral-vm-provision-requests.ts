import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeSecureJsonFileWithinLimit } from '../../shared/bounded-secure-json-file'

const MAX_REQUEST_BYTES = 1024 * 1024
const recordSchema = z
  .object({
    hash: z.string(),
    state: z.enum(['pending', 'settled']),
    result: z.unknown().optional()
  })
  .strict()
const active = new Map<
  string,
  { hash: string; promise: Promise<unknown>; controller: AbortController }
>()

/** A lost client may retry; an interrupted host must never blindly create another VM. */
export async function runEphemeralVmProvisionRequest(
  userDataPath: string,
  args: { provisionId: string },
  run: (signal: AbortSignal) => Promise<unknown>
): Promise<unknown> {
  const directory = join(userDataPath, 'ephemeral-vm-provision-requests')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const key = createHash('sha256').update(args.provisionId).digest('hex')
  const hash = createHash('sha256').update(JSON.stringify(args)).digest('hex')
  const path = join(directory, `${key}.json`)
  const inFlight = active.get(path)
  if (inFlight) {
    if (inFlight.hash !== hash) {
      throw new Error('Provision request id was reused with different arguments.')
    }
    return inFlight.promise
  }
  if (existsSync(path)) {
    const saved = recordSchema.parse(
      JSON.parse(readNodeFileSyncWithinLimit(path, MAX_REQUEST_BYTES).buffer.toString('utf8'))
    )
    if (saved.hash !== hash) {
      throw new Error('Provision request id was reused with different arguments.')
    }
    if (saved.state === 'settled') {
      return saved.result
    }
    throw new Error(
      'Provisioning was interrupted on the server. Inspect its VM runtimes and provider resources before starting a new request.'
    )
  }
  if (readdirSync(directory).length >= 4096) {
    throw new Error(
      'Provision request history is full. Archive settled requests before continuing.'
    )
  }
  writeSecureJsonFileWithinLimit(path, { hash, state: 'pending' }, MAX_REQUEST_BYTES, {
    durable: true
  })
  const controller = new AbortController()
  const promise = Promise.resolve()
    .then(() => run(controller.signal))
    .then((result) => {
      writeSecureJsonFileWithinLimit(path, { hash, state: 'settled', result }, MAX_REQUEST_BYTES, {
        durable: true
      })
      return result
    })
    .finally(() => active.delete(path))
  active.set(path, { hash, promise, controller })
  return promise
}

export function cancelEphemeralVmProvisionRequest(
  userDataPath: string,
  provisionId: string
): boolean {
  const key = createHash('sha256').update(provisionId).digest('hex')
  const entry = active.get(join(userDataPath, 'ephemeral-vm-provision-requests', `${key}.json`))
  if (!entry) {
    return false
  }
  entry.controller.abort()
  return true
}
