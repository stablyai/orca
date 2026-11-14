import { describe, expect, it, vi } from 'vitest'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../../transport/rpc/rpc-wire-types'
import { saveMobileTerminalArtifactPreview } from './mobile-file-preview-request'

import '../../transport/rpc/rpc-incompatible-reply-error'

function ok(result: unknown): RpcSuccess {
  return { id: '1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function fail(message: string, code = 'error'): RpcFailure {
  return { id: '1', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

function clientWith(response: RpcResponse) {
  return {
    sendRequest: vi.fn(async () => response)
  }
}

function clientWithResponses(responses: RpcResponse[]) {
  return {
    sendRequest: vi.fn(async () => responses.shift()!)
  }
}

describe('mobile-file-preview-request', () => {
  it('does not send writes for read-only native-chat artifacts', async () => {
    const client = clientWith(ok({ ok: true }))

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/Users/ada/orca-plans/result.html',
          grantId: 'grant-1',
          readOnly: true
        },
        '<h1>Changed</h1>'
      )
    ).resolves.toMatchObject({ status: 'error' })
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('refreshes an expired terminal artifact grant and retries save when the file still matches the base content', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_expired'),
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-2'
        }
      }),
      ok({ content: '{"ok":true}', truncated: false, byteLength: 11 }),
      ok({ ok: true })
    ])
    const onTerminalArtifactSourceRefreshed = vi.fn()

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1',
          pathText: 'result.json',
          cwd: '/tmp/run'
        },
        '{"ok":false}',
        { baseContent: '{"ok":true}', onTerminalArtifactSourceRefreshed }
      )
    ).resolves.toEqual({ status: 'saved' })

    expect(client.sendRequest).toHaveBeenNthCalledWith(1, 'files.readTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'files.resolveTerminalPath', {
      worktree: 'id:wt-1',
      pathText: 'result.json',
      cwd: '/tmp/run',
      terminal: 'term-1'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(3, 'files.readTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(4, 'files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      content: '{"ok":false}'
    })
    expect(onTerminalArtifactSourceRefreshed).toHaveBeenCalledWith({
      source: 'terminalArtifact',
      worktreeId: 'wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      terminalHandle: 'term-1',
      pathText: 'result.json',
      cwd: '/tmp/run'
    })
  })
})
