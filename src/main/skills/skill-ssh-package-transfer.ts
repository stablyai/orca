import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillBundleInstallRequest } from '../../shared/skill-bundle-install-contract'
import type { SkillInstallRequest } from '../../shared/skill-install-contract'
import {
  SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD,
  SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD,
  SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD,
  SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD
} from '../../shared/skill-ssh-relay-contract'
import {
  SKILL_UPLOAD_CHUNK_MAX_BYTES,
  SkillUploadBeginResultSchema
} from '../../shared/skill-upload-session-contract'
import { downloadSkillPackageGrant } from './skill-package-download'
import { startSkillPhaseOperation } from './skill-operation-observability'
import {
  SKILL_SSH_REQUEST_TIMEOUT_MS,
  retryableSkillSshTransportError,
  type SkillSshRelayClient
} from './skill-ssh-relay-client'
import { retrySkillTransferRpc, throwIfSkillTransferCancelled } from './skill-transfer-rpc-retry'

type SkillSshTransferInput = {
  userDataPath: string
  request: SkillInstallRequest | SkillBundleInstallRequest
  requireHttps: boolean
  signal?: AbortSignal
  fetcher?: typeof fetch
}

function allowedOrigins(requireHttps: boolean): string[] {
  const origins = ['https://storage.googleapis.com']
  if (!requireHttps && process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS) {
    origins.push(
      ...process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    )
  }
  return [...new Set(origins)]
}

async function transferSkillPackageToSshHostUnobserved(
  client: SkillSshRelayClient,
  input: SkillSshTransferInput
): Promise<string> {
  if (input.request.ingress.kind !== 'download-grant') {
    throw new Error('skill-install-ssh-ingress-invalid')
  }
  const downloaded = await downloadSkillPackageGrant({
    url: input.request.ingress.url,
    expiresAt: input.request.ingress.expiresAt,
    expectedArchiveSha256: input.request.package.archiveSha256,
    expectedCompressedBytes: input.request.package.compressedBytes,
    temporaryRoot: join(input.userDataPath, 'skill-installs', 'ssh-transfers'),
    allowedOrigins: allowedOrigins(input.requireHttps),
    requireHttps: input.requireHttps,
    signal: input.signal,
    fetcher: input.fetcher
  })
  let uploadId: string | null = null
  try {
    const begun = SkillUploadBeginResultSchema.parse(
      await retrySkillTransferRpc({
        signal: input.signal,
        checkCancellationAfterSuccess: false,
        retryable: retryableSkillSshTransportError,
        call: () =>
          client(
            SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD,
            { package: input.request.package, transferId: input.request.operationId },
            { timeoutMs: SKILL_SSH_REQUEST_TIMEOUT_MS, signal: input.signal }
          )
      })
    )
    uploadId = begun.uploadId
    throwIfSkillTransferCancelled(input.signal)
    const chunkBytes = Math.min(begun.chunkBytes, SKILL_UPLOAD_CHUNK_MAX_BYTES)
    if (
      begun.acknowledgedOffset > input.request.package.compressedBytes ||
      !Number.isInteger(chunkBytes) ||
      chunkBytes < 1
    ) {
      throw new Error('skill-transfer-ssh-begin-invalid')
    }
    const handle = await open(downloaded.archivePath, 'r')
    try {
      let offset = begun.acknowledgedOffset
      while (offset < input.request.package.compressedBytes) {
        const bytes = Buffer.alloc(
          Math.min(chunkBytes, input.request.package.compressedBytes - offset)
        )
        const read = await handle.read(bytes, 0, bytes.length, offset)
        if (read.bytesRead !== bytes.length) {
          throw new Error('skill-transfer-source-changed')
        }
        const acknowledged = (await retrySkillTransferRpc({
          signal: input.signal,
          retryable: retryableSkillSshTransportError,
          call: () =>
            client(
              SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD,
              { uploadId, offset, bytesBase64: bytes.toString('base64') },
              { timeoutMs: SKILL_SSH_REQUEST_TIMEOUT_MS, signal: input.signal }
            )
        })) as { acknowledgedOffset: number }
        if (acknowledged.acknowledgedOffset !== offset + bytes.length) {
          throw new Error('skill-transfer-ack-invalid')
        }
        offset = acknowledged.acknowledgedOffset
      }
    } finally {
      await handle.close()
    }
    await retrySkillTransferRpc({
      signal: input.signal,
      retryable: retryableSkillSshTransportError,
      call: () =>
        client(
          SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD,
          { uploadId },
          { timeoutMs: SKILL_SSH_REQUEST_TIMEOUT_MS, signal: input.signal }
        )
    })
    const committedId = uploadId
    uploadId = null
    return committedId
  } finally {
    await downloaded.cleanup()
    if (uploadId) {
      await client(SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD, { uploadId }).catch(() => undefined)
    }
  }
}

export async function transferSkillPackageToSshHost(
  client: SkillSshRelayClient,
  input: SkillSshTransferInput
): Promise<string> {
  const operation = startSkillPhaseOperation({
    phase: 'transfer',
    transport: 'ssh-relay',
    destination: 'global-ssh',
    compressedBytes: input.request.package.compressedBytes
  })
  try {
    const uploadId = await transferSkillPackageToSshHostUnobserved(client, input)
    operation.complete({
      status: 'complete',
      compressedBytes: input.request.package.compressedBytes
    })
    return uploadId
  } catch (error) {
    operation.fail(error)
    throw error
  }
}
