import { describe, expect, it, vi } from 'vitest'
import { handleMockFilePreviewRequest } from '../../scripts/mock-server-file-preview-data'
import { error, success, type RpcResponse } from '../../scripts/mock-server-rpc-handlers'

function request(method: string, params: Record<string, unknown>) {
  return { id: 'req-1', method, params }
}

function capture(method: string, params: Record<string, unknown>): RpcResponse {
  const respond = vi.fn()
  const handled = handleMockFilePreviewRequest(request(method, params), respond, success, error)
  expect(handled).toBe(true)
  expect(respond).toHaveBeenCalledTimes(1)
  return respond.mock.calls[0]?.[0] as RpcResponse
}

describe('mock file preview data', () => {
  it('resolves terminal screenshot paths into worktree-relative files', () => {
    expect(
      capture('files.resolveTerminalPath', {
        worktree: 'id:wt-1',
        pathText: 'artifacts/screenshot.png'
      })
    ).toMatchObject({
      ok: true,
      result: {
        relativePath: 'artifacts/screenshot.png',
        absolutePath: '/tmp/orca-mobile-repro/orca/artifacts/screenshot.png',
        exists: true,
        isDirectory: false
      }
    })

    expect(
      capture('files.resolveTerminalPath', {
        worktree: 'id:wt-1',
        pathText: '/tmp/orca-mobile-repro/orca/artifacts/screenshot.png'
      })
    ).toMatchObject({
      ok: true,
      result: {
        relativePath: 'artifacts/screenshot.png',
        exists: true
      }
    })
  })

  it('serves screenshot image previews through files.readPreview', () => {
    expect(
      capture('files.readPreview', {
        worktree: 'id:wt-1',
        relativePath: 'artifacts/screenshot.png'
      })
    ).toMatchObject({
      ok: true,
      result: {
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      }
    })
  })
})
