import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import {
  MOBILE_WEB_FILE_EDIT_MAX_BYTES,
  MobileWebFileWritePayloadSchema,
  MobileWebFileWriteResultSchema,
  type MobileWebFileWriteResult
} from '../../../src/shared/mobile-web/file-edit-contract'
import { captureMobileFileMutationOwnership } from '../files/mobile-file-mutation-ownership'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebFileWrite(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
): Promise<MobileWebFileWriteResult> {
  const payload = MobileWebFileWritePayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const bytes = decodeUtf8(payload.contentBase64)
  let ownership: Awaited<ReturnType<typeof captureMobileFileMutationOwnership>>
  try {
    ownership = await captureMobileFileMutationOwnership(client, `id:${hostWorkspaceId}`)
  } catch {
    throw new MobileWebBrokerError('conflict')
  }
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  const response = await client.sendRequest('files.writeIfUnchanged', {
    worktree: `id:${hostWorkspaceId}`,
    relativePath: payload.relativePath,
    expectedRevision: payload.expectedRevision,
    contentBase64: payload.contentBase64,
    ...ownership
  })
  if (!response.ok || !isRecord(response.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  if (
    response.result.ok === false &&
    (response.result.code === 'conflict' || response.result.code === 'too_large')
  ) {
    throw new MobileWebBrokerError(response.result.code)
  }
  const revision = sha256Hex(bytes)
  if (
    response.result.ok !== true ||
    response.result.revision !== revision ||
    response.result.byteLength !== bytes.byteLength
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebFileWriteResultSchema.parse({
    workspaceId: payload.workspaceId,
    relativePath: payload.relativePath,
    revision,
    byteLength: bytes.byteLength,
    outcome: 'updated'
  })
}

function decodeUtf8(contentBase64: string): Uint8Array {
  const bytes = Buffer.from(contentBase64, 'base64')
  if (bytes.byteLength > MOBILE_WEB_FILE_EDIT_MAX_BYTES) {
    throw new MobileWebBrokerError('too_large')
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new MobileWebBrokerError('invalid_request')
  }
  return bytes
}

function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
