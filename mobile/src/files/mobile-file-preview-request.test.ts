import { describe, expect, it, vi } from 'vitest'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import {
  loadMobileFilePreview,
  saveMobileTerminalArtifactPreview
} from './mobile-file-preview-request'

import { RPC_INCOMPATIBLE_REPLY_CODE } from '../transport/rpc-incompatible-reply-error'

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
  it('refreshes an expired terminal artifact grant and retries the read once', async () => {
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
      ok({ content: '{"ok":true}', truncated: false, byteLength: 11 })
    ])
    const onTerminalArtifactSourceRefreshed = vi.fn()

    await expect(
      loadMobileFilePreview(
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
        undefined,
        { onTerminalArtifactSourceRefreshed, isCurrent: () => true }
      )
    ).resolves.toMatchObject({ status: 'ready', kind: 'text', content: '{"ok":true}' })

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
    expect(client.sendRequest).toHaveBeenCalledTimes(3)
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

  it.each([
    ['terminal_file_grant_expired'],
    ['terminal_file_grant_mismatch'],
    ['terminal_file_grant_stale']
  ])(
    'does not refresh a %s terminal artifact grant when disabled for a dirty editor',
    async (error) => {
      const client = clientWithResponses([fail(error)])

      await expect(
        loadMobileFilePreview(
          client,
          {
            source: 'terminalArtifact',
            worktreeId: 'wt-1',
            absolutePath: '/tmp/result.json',
            grantId: 'grant-1'
          },
          undefined,
          { refreshGrant: false }
        )
      ).resolves.toEqual({
        status: 'error',
        message: 'Reload preview before saving',
        reconnect: false
      })

      expect(client.sendRequest).toHaveBeenCalledTimes(1)
      expect(client.sendRequest).toHaveBeenCalledWith('files.readTerminalArtifact', {
        worktree: 'id:wt-1',
        absolutePath: '/tmp/result.json',
        grantId: 'grant-1'
      })
    }
  )

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

  it('does not refresh and retry a failed terminal artifact save without a base content check', async () => {
    const client = clientWithResponses([fail('terminal_file_grant_mismatch')])

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
        '{"ok":false}'
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'Reload preview before saving',
      reconnect: false
    })

    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(client.sendRequest).toHaveBeenCalledWith('files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1',
      content: '{"ok":false}'
    })
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

  it('keeps the dirty draft when a refreshed terminal artifact save finds changed remote content', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_stale'),
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
      ok({ content: '{"ok":"changed"}', truncated: false, byteLength: 16 })
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
          terminalHandle: 'term-1'
        },
        '{"ok":false}',
        { baseContent: '{"ok":true}', onTerminalArtifactSourceRefreshed }
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'File changed on desktop. Reload preview before saving',
      reconnect: false
    })

    expect(client.sendRequest).toHaveBeenCalledTimes(3)
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      content: '{"ok":false}'
    })
    expect(onTerminalArtifactSourceRefreshed).not.toHaveBeenCalled()
  })

  it('reports a failed refreshed artifact read instead of treating it as changed desktop content', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_stale'),
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
      fail('provider unavailable')
    ])

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1'
        },
        '{"ok":false}',
        { baseContent: '{"ok":true}' }
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'Unable to reach the desktop filesystem',
      reconnect: true
    })

    expect(client.sendRequest).toHaveBeenCalledTimes(3)
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      content: '{"ok":false}'
    })
  })

  it('names the unreadable reply on a refreshed artifact read instead of treating it as changed desktop content', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_stale'),
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
      ok({ truncated: false, byteLength: 11 })
    ])

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1'
        },
        '{"ok":false}',
        { baseContent: '{"ok":true}' }
      )
    ).rejects.toMatchObject({
      code: RPC_INCOMPATIBLE_REPLY_CODE,
      method: 'files.readTerminalArtifact'
    })

    expect(client.sendRequest).toHaveBeenCalledTimes(3)
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      content: '{"ok":false}'
    })
  })

  it('does not retry a dirty save when grant refresh resolves to a different artifact', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_expired'),
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/b.json',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          absolutePath: '/tmp/b.json',
          grantId: 'grant-2'
        }
      })
    ])
    const onTerminalArtifactSourceRefreshed = vi.fn()

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/a.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1',
          pathText: '/tmp/link.json'
        },
        '{"ok":false}',
        { baseContent: '{"ok":true}', onTerminalArtifactSourceRefreshed }
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'Reload preview before saving',
      reconnect: false
    })

    expect(client.sendRequest).toHaveBeenCalledTimes(2)
    expect(onTerminalArtifactSourceRefreshed).not.toHaveBeenCalled()
  })
})
