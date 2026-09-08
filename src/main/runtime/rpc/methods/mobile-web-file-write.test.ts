import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { MOBILE_WEB_FILE_WRITE_METHOD } from './mobile-web-file-write'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'

const BEFORE = Buffer.from('before', 'utf8')
const AFTER = Buffer.from('after', 'utf8')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function fixture(hostId?: string) {
  const runtime = {
    showManagedWorktree: vi.fn().mockResolvedValue({ id: 'workspace', hostId }),
    readFileExplorerChunk: vi.fn().mockResolvedValue({
      contentBase64: BEFORE.toString('base64'),
      bytesRead: BEFORE.byteLength,
      eof: true
    }),
    writeFileExplorerFile: vi.fn().mockResolvedValue({ ok: true })
  }
  return { runtime, context: { runtime } as unknown as RpcContext }
}

const params = {
  worktree: 'id:workspace',
  relativePath: 'src/index.ts',
  expectedRevision: sha(BEFORE),
  contentBase64: AFTER.toString('base64')
}

describe('mobile web file write', () => {
  it('writes and answers with the revision of the bytes it stored', async () => {
    const f = fixture()
    expect(await MOBILE_WEB_FILE_WRITE_METHOD.handler(params, f.context)).toEqual({
      relativePath: 'src/index.ts',
      revision: sha(AFTER),
      byteLength: AFTER.byteLength,
      outcome: 'updated'
    })
    expect(f.runtime.writeFileExplorerFile).toHaveBeenCalledWith(
      'id:workspace',
      'src/index.ts',
      'after',
      undefined,
      undefined,
      'local'
    )
  })

  it('names the ssh host and its live generation so a rehome mid-write is refused', async () => {
    const f = fixture('ssh:target-1')
    await MOBILE_WEB_FILE_WRITE_METHOD.handler(params, f.context)
    expect(f.runtime.writeFileExplorerFile.mock.calls[0]?.slice(4)).toEqual([
      'target-1',
      'ssh:target-1'
    ])
  })

  it('reports a stale revision as an outcome the page can act on', async () => {
    const f = fixture()
    expect(
      await MOBILE_WEB_FILE_WRITE_METHOD.handler(
        { ...params, expectedRevision: 'b'.repeat(64) },
        f.context
      )
    ).toEqual({ outcome: 'conflict' })
    expect(f.runtime.writeFileExplorerFile).not.toHaveBeenCalled()
  })

  it('reports a file past the edit ceiling as an outcome, not a failure', async () => {
    const f = fixture()
    f.runtime.readFileExplorerChunk.mockResolvedValue({
      contentBase64: BEFORE.toString('base64'),
      bytesRead: BEFORE.byteLength,
      eof: false
    })
    expect(await MOBILE_WEB_FILE_WRITE_METHOD.handler(params, f.context)).toEqual({
      outcome: 'too_large'
    })
  })

  it('is reachable from a mobile socket', () => {
    expect(isMobileWebHostRpcMethod('mobileWeb.files.write')).toBe(true)
  })
})
