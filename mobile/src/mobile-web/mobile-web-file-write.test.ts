import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_FILE_EDIT_MAX_BASE64_CHARACTERS,
  MOBILE_WEB_FILE_EDIT_MAX_BYTES
} from '../../../src/shared/mobile-web/file-edit-contract'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebFileWrite } from './mobile-web-file-write'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const IDENTITY_WORKSPACE_AUTHORITY = createMobileWebWorkspaceAuthorityFixture(
  'repo-1::/workspace',
  'repo-1::/workspace'
)

describe('mobile web conflict-safe file write', () => {
  it('captures local mutation ownership and returns only stable file identity', async () => {
    const client = fileClient({
      ok: true,
      revision: revision('after'),
      byteLength: 5
    })
    const result = await executeMobileWebFileWrite(
      payload('after'),
      client,
      IDENTITY_WORKSPACE_AUTHORITY
    )

    expect(client.sendRequest).toHaveBeenLastCalledWith('files.writeIfUnchanged', {
      worktree: 'id:repo-1::/workspace',
      relativePath: 'src/index.ts',
      expectedRevision: revision('before'),
      contentBase64: Buffer.from('after').toString('base64'),
      expectedExecutionHostId: 'local'
    })
    expect(result).toEqual({
      workspaceId: 'repo-1::/workspace',
      relativePath: 'src/index.ts',
      revision: revision('after'),
      byteLength: 5,
      outcome: 'updated'
    })
  })

  it('maps stale content and malformed host results to stable broker errors', async () => {
    const conflict = fileClient({ ok: false, code: 'conflict' })
    await expect(
      executeMobileWebFileWrite(payload('after'), conflict, IDENTITY_WORKSPACE_AUTHORITY)
    ).rejects.toMatchObject({ code: 'conflict' })

    const mismatch = fileClient({
      ok: true,
      revision: revision('different'),
      byteLength: 5,
      rawPath: '/private/workspace/src/index.ts'
    })
    const error = await executeMobileWebFileWrite(
      payload('after'),
      mismatch,
      IDENTITY_WORKSPACE_AUTHORITY
    ).catch((writeError: unknown) => writeError)
    expect(error).toMatchObject({ code: 'host_error' })
    expect(JSON.stringify(error)).not.toContain('/private/workspace')
  })

  it('grants exactly one bounded, conservatively rated production writer', () => {
    const grant = MOBILE_WEB_PRODUCTION_GRANTS.find(
      (candidate) => candidate.capability === 'file' && candidate.operation === 'write'
    )
    if (!grant) {
      throw new Error('missing production file write grant')
    }
    const maximumPayload = {
      workspaceId: 'w'.repeat(512),
      relativePath: 'p'.repeat(1024),
      expectedRevision: 'a'.repeat(64),
      contentBase64: Buffer.alloc(MOBILE_WEB_FILE_EDIT_MAX_BYTES).toString('base64')
    }

    expect(new TextEncoder().encode(JSON.stringify(maximumPayload)).byteLength).toBeLessThanOrEqual(
      grant.limits.maxRequestBytes
    )
    expect(grant.limits).toEqual({
      maxRequestBytes: MOBILE_WEB_FILE_EDIT_MAX_BASE64_CHARACTERS + 4096,
      maxResponseBytes: 2048,
      maxConcurrent: 1,
      rateCapacity: 3,
      rateRefillPerSecond: 0.5
    })
  })
})

function payload(content: string) {
  return {
    workspaceId: 'repo-1::/workspace',
    relativePath: 'src/index.ts',
    expectedRevision: revision('before'),
    contentBase64: Buffer.from(content).toString('base64')
  }
}

function fileClient(writeResult: unknown): RpcClient & {
  sendRequest: ReturnType<typeof vi.fn>
} {
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'status.get') {
      return { ok: true, result: { capabilities: ['files.mutation-ownership.v1'] } }
    }
    if (method === 'worktree.show') {
      return { ok: true, result: { worktree: { hostId: 'local' } } }
    }
    if (method === 'files.writeIfUnchanged') {
      return { ok: true, result: writeResult }
    }
    return { ok: false, error: { message: `Unexpected ${method}` } }
  })
  return { sendRequest } as unknown as RpcClient & {
    sendRequest: ReturnType<typeof vi.fn>
  }
}

function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
