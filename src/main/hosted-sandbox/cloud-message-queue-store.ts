// Queued prompts on disk: sealed with the OS keychain; without one they live in memory only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CloudQueuedPrompt } from '../../shared/hosted-sandbox/cloud-workspace-offline-api'
import type { OfflineCacheCodec } from './cloud-offline-cache'

export type StoredPrompt = CloudQueuedPrompt & {
  clientOperationId: string
  /** Failed attempts (wake, transport, refusal-to-retry); the prompt fails at the budget. */
  failures: number
  /** No background attempt before this (backoff). */
  nextAttemptAt: number
}

export function readSealedPrompts(path: string, codec: OfflineCacheCodec | null): StoredPrompt[] {
  if (!codec) {
    return []
  }
  try {
    const parsed = JSON.parse(codec.decrypt(readFileSync(path))) as {
      version: 2
      prompts: StoredPrompt[]
    }
    return parsed.version === 2 && Array.isArray(parsed.prompts) ? parsed.prompts : []
  } catch {
    return []
  }
}

export function writeSealedPrompts(
  path: string,
  codec: OfflineCacheCodec | null,
  prompts: readonly StoredPrompt[]
): void {
  if (!codec) {
    return
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, codec.encrypt(JSON.stringify({ version: 2, prompts })), { mode: 0o600 })
  renameSync(temp, path)
}
