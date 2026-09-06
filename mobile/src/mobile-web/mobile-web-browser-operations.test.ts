import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { executeMobileWebBrowserOperation } from './mobile-web-browser-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web browser operations', () => {
  it('resolves opaque workspace and page authority for navigation', async () => {
    const { workspaceAuthority, browserAuthority, workspaceId, pageId } = authorities()
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: { url: 'https://example.com/', title: 'Example', rawPageId: 'raw-page' }
    })

    await expect(
      executeMobileWebBrowserOperation({
        operation: 'navigate',
        payload: { workspaceId, pageId, url: 'https://example.com' },
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority,
        browserAuthority
      })
    ).resolves.toEqual({ url: 'https://example.com/' })

    expect(sendRequest).toHaveBeenCalledWith(
      'browser.goto',
      {
        worktree: 'id:host-workspace',
        page: 'raw-page',
        url: 'https://example.com'
      },
      { timeoutMs: 30_000 }
    )
  })

  it('removes credentials from the authoritative navigation result', async () => {
    const { workspaceAuthority, browserAuthority, workspaceId, pageId } = authorities()
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: {
        url: 'https://user:password@example.com/callback?code=secret&tab=review#access_token=secret'
      }
    })

    await expect(
      executeMobileWebBrowserOperation({
        operation: 'navigate',
        payload: { workspaceId, pageId, url: 'https://example.com' },
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority,
        browserAuthority
      })
    ).resolves.toEqual({ url: 'https://example.com/callback?tab=review' })
  })

  it('keeps pointer fallback native and rejects cross-workspace page handles', async () => {
    const { workspaceAuthority, browserAuthority, workspaceId, pageId } = authorities()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'unsupported', message: 'unsupported' } })
      .mockResolvedValue({ ok: true, result: null })
    const client = { sendRequest } as unknown as RpcClient

    await executeMobileWebBrowserOperation({
      operation: 'pointer',
      payload: {
        workspaceId,
        pageId,
        action: 'click',
        x: 20,
        y: 30,
        button: 'left',
        modifiers: []
      },
      client,
      workspaceAuthority,
      browserAuthority
    })

    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'browser.mouseClick',
      'browser.mouseMove',
      'browser.mouseDown',
      'browser.mouseUp'
    ])

    workspaceAuthority.synchronize([
      { workspaceId: 'host-workspace', repoId: 'repo-1' },
      { workspaceId: 'other-workspace', repoId: 'repo-1' }
    ])
    const otherWorkspaceId = workspaceAuthority.pageWorkspaceId('other-workspace')
    await expect(
      executeMobileWebBrowserOperation({
        operation: 'reload',
        payload: { workspaceId: otherWorkspaceId, pageId },
        client,
        workspaceAuthority,
        browserAuthority
      })
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

function authorities(): {
  workspaceAuthority: MobileWebWorkspaceAuthority
  browserAuthority: MobileWebBrowserAuthority
  workspaceId: string
  pageId: string
} {
  const randomBytes = (length: number): Uint8Array => new Uint8Array(length).fill(3)
  const workspaceAuthority = new MobileWebWorkspaceAuthority(randomBytes)
  workspaceAuthority.synchronize([{ workspaceId: 'host-workspace', repoId: 'repo-1' }])
  const browserAuthority = new MobileWebBrowserAuthority(randomBytes)
  return {
    workspaceAuthority,
    browserAuthority,
    workspaceId: workspaceAuthority.pageWorkspaceId('host-workspace'),
    pageId: browserAuthority.register('host-workspace', 'raw-page')
  }
}
