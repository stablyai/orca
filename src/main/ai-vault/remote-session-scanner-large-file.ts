import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import type { RemoteScannerContext, RemoteSessionCandidate } from './remote-session-scanner-types'

export const REMOTE_SESSION_IN_MEMORY_LIMIT_BYTES = 10 * 1024 * 1024
export const MAX_REMOTE_SESSION_DOWNLOAD_BYTES = 256 * 1024 * 1024

type RemoteLargeSessionParseResult =
  | { handled: false }
  | { handled: true; session: AiVaultSession | null }

export async function tryParseLargeRemoteSession(
  candidate: RemoteSessionCandidate,
  context: RemoteScannerContext
): Promise<RemoteLargeSessionParseResult> {
  const sizeBytes = candidate.file.sizeBytes
  if (
    sizeBytes === undefined ||
    sizeBytes <= REMOTE_SESSION_IN_MEMORY_LIMIT_BYTES ||
    !context.provider.downloadFile ||
    !candidate.source.createParseState
  ) {
    return { handled: false }
  }

  throwIfAiVaultScanCancelled(context.signal)
  const state = candidate.source.createParseState(candidate.file, context)
  if (!state) {
    return { handled: false }
  }
  assertRemoteSessionDownloadSize(sizeBytes)

  const tempDir = await mkdtemp(join(tmpdir(), 'orca-remote-session-'))
  const tempPath = join(tempDir, 'transcript.jsonl')
  try {
    throwIfAiVaultScanCancelled(context.signal)
    await context.provider.downloadFile(candidate.file.path, tempPath)
    throwIfAiVaultScanCancelled(context.signal)
    assertRemoteSessionDownloadSize((await stat(tempPath)).size)
    const input = createReadStream(tempPath, { encoding: 'utf-8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        throwIfAiVaultScanCancelled(context.signal)
        state.consumeLine(line)
      }
    } finally {
      lines.close()
      input.destroy()
    }
    throwIfAiVaultScanCancelled(context.signal)
    const session = await state.finalize(context.hostPlatform.os, {
      executionHostId: context.executionHostId,
      executionHostPlatform: context.hostPlatform.os
    })
    throwIfAiVaultScanCancelled(context.signal)
    return { handled: true, session }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function toMegabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

function assertRemoteSessionDownloadSize(sizeBytes: number): void {
  if (sizeBytes > MAX_REMOTE_SESSION_DOWNLOAD_BYTES) {
    throw new Error(
      `Remote session transcript is too large to scan safely: ${toMegabytes(sizeBytes)}MB exceeds ${toMegabytes(MAX_REMOTE_SESSION_DOWNLOAD_BYTES)}MB limit`
    )
  }
}
