import { isAbsolute } from 'node:path'
import type { Readable } from 'node:stream'
import { parseRelayOwnerResetRequest } from '../shared/relay-owner-reset-contract'
import {
  parseRelayResetPreparationBinding,
  RELAY_RESET_PREPARATION_READ_FLAG,
  validateRelayResetPreparationRecord
} from '../shared/relay-reset-preparation-contract'
import { RelayOwnerResetPreparationJournal } from './relay-owner-reset-preparation-journal'

export { RELAY_RESET_PREPARATION_READ_FLAG } from '../shared/relay-reset-preparation-contract'
const MAX_INPUT_BYTES = 64 * 1024

export function isRelayResetPreparationReadMode(argv: readonly string[]): boolean {
  const args = argv.slice(2)
  if (!args.includes(RELAY_RESET_PREPARATION_READ_FLAG)) {
    return false
  }
  if (args.length !== 1 || args[0] !== RELAY_RESET_PREPARATION_READ_FLAG) {
    throw new Error('relay_reset_preparation_read_arguments_invalid')
  }
  return true
}

/** The invoking SSH account supplies OS read authority; no relay session or daemon is started. */
export function readRelayResetPreparation(value: unknown) {
  const envelope = value as { version?: unknown; binding?: unknown; request?: unknown } | null
  if (!envelope || envelope.version !== 1) {
    throw new Error('relay_reset_preparation_read_invalid')
  }
  const binding = parseRelayResetPreparationBinding(envelope.binding)
  const request = parseRelayOwnerResetRequest(envelope.request)
  if (!isAbsolute(binding.journalDirectory)) {
    throw new Error('relay_reset_preparation_read_directory_invalid')
  }
  const journal = new RelayOwnerResetPreparationJournal(
    binding.journalDirectory,
    binding.sockPath,
    binding.serverBuildId
  )
  const record = journal.read(request)
  return {
    version: 1 as const,
    preparation: record ? validateRelayResetPreparationRecord(record, binding, request) : null
  }
}

export async function readRelayResetPreparationStdin(input: Readable): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  const timeout = setTimeout(
    () => input.destroy(new Error('relay_reset_preparation_read_timeout')),
    10_000
  )
  timeout.unref?.()
  try {
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      bytes += chunk.length
      if (bytes > MAX_INPUT_BYTES) {
        throw new Error('relay_reset_preparation_read_too_large')
      }
      chunks.push(chunk)
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return `${JSON.stringify(readRelayResetPreparation(request))}\n`
  } catch {
    // Parse and filesystem errors can contain credentials from the request or journal.
    throw new Error('relay_reset_preparation_read_failed')
  } finally {
    clearTimeout(timeout)
  }
}
