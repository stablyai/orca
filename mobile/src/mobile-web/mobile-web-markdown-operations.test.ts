import { Buffer } from 'buffer/'
import { describe, expect, it, vi } from 'vitest'
import { MOBILE_MARKDOWN_EDIT_MAX_BYTES } from '../../../src/shared/mobile-markdown-document'
import { MARKDOWN_TOO_LARGE_READ_ONLY_REASON } from '../session/mobile-markdown-disk-fallback'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import { executeMobileWebMarkdownOperation } from './mobile-web-markdown-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const PAGE_TARGET = {
  workspaceId: 'workspace-page',
  tabId: 'tab-1',
  relativePath: 'notes.md'
}
const HOST_WORKSPACE_ID = 'repo-1::/secret/worktree'
const WORKSPACE_AUTHORITY = createMobileWebWorkspaceAuthorityFixture(
  PAGE_TARGET.workspaceId,
  HOST_WORKSPACE_ID
)

describe('mobile web markdown operations', () => {
  it('re-resolves host authority and returns no host paths', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(tabsResponse())
      .mockResolvedValueOnce({
        ok: true,
        result: {
          ...PAGE_TARGET,
          filePath: '/secret/worktree/notes.md',
          content: 'hello',
          version: 'v1',
          isDirty: false,
          editable: true
        }
      })

    const result = await executeMobileWebMarkdownOperation({
      operation: 'markdownRead',
      payload: { ...PAGE_TARGET, tabIsDirty: false },
      client: rpcClient(sendRequest),
      workspaceAuthority: WORKSPACE_AUTHORITY,
      nativeAuthority: {}
    })

    expect(sendRequest).toHaveBeenNthCalledWith(1, 'session.tabs.list', {
      worktree: `id:${HOST_WORKSPACE_ID}`
    })
    expect(sendRequest).toHaveBeenNthCalledWith(2, 'markdown.readTab', {
      worktree: `id:${HOST_WORKSPACE_ID}`,
      tabId: PAGE_TARGET.tabId
    })
    expect(result).toMatchObject({
      ...PAGE_TARGET,
      contentBase64: Buffer.from('hello').toString('base64'),
      baseVersion: 'v1',
      editable: true,
      stale: false
    })
    expect(JSON.stringify(result)).not.toContain('/secret')
  })

  it('rejects a stale path binding before reading or saving', async () => {
    const sendRequest = vi.fn().mockResolvedValue(
      tabsResponse({
        tabs: [{ type: 'markdown', id: PAGE_TARGET.tabId, relativePath: 'renamed.md' }]
      })
    )

    await expect(
      executeMobileWebMarkdownOperation({
        operation: 'markdownSave',
        payload: {
          ...PAGE_TARGET,
          baseVersion: 'v1',
          contentBase64: Buffer.from('edit').toString('base64')
        },
        client: rpcClient(sendRequest),
        workspaceAuthority: WORKSPACE_AUTHORITY,
        nativeAuthority: {}
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('preserves a renderer save conflict as a stable bridge conflict', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(tabsResponse())
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'runtime_error', message: 'conflict' }
      })

    await expect(
      executeMobileWebMarkdownOperation({
        operation: 'markdownSave',
        payload: {
          ...PAGE_TARGET,
          baseVersion: 'v1',
          contentBase64: Buffer.from('mobile draft').toString('base64')
        },
        client: rpcClient(sendRequest),
        workspaceAuthority: WORKSPACE_AUTHORITY,
        nativeAuthority: {}
      })
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('preserves the renderer-unavailable disk fallback as read-only', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(tabsResponse())
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'renderer_unavailable', message: 'renderer_unavailable' }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          worktree: HOST_WORKSPACE_ID,
          relativePath: PAGE_TARGET.relativePath,
          content: 'disk',
          truncated: false
        }
      })

    const result = await executeMobileWebMarkdownOperation({
      operation: 'markdownRead',
      payload: { ...PAGE_TARGET, tabIsDirty: true },
      client: rpcClient(sendRequest),
      workspaceAuthority: WORKSPACE_AUTHORITY,
      nativeAuthority: {}
    })

    expect(result).toMatchObject({
      contentBase64: Buffer.from('disk').toString('base64'),
      baseVersion: '',
      editable: false,
      stale: true,
      readOnlyReason: 'Desktop has unsaved changes. Showing disk content.'
    })
  })

  it('serves oversized host content read-only and stores drafts under host authority', async () => {
    const oversizedClient = rpcClient(
      vi
        .fn()
        .mockResolvedValueOnce(tabsResponse())
        .mockResolvedValueOnce({
          ok: true,
          result: {
            ...PAGE_TARGET,
            content: 'x'.repeat(MOBILE_MARKDOWN_EDIT_MAX_BYTES + 1),
            version: 'v1',
            isDirty: false,
            editable: true
          }
        })
    )
    await expect(
      executeMobileWebMarkdownOperation({
        operation: 'markdownRead',
        payload: { ...PAGE_TARGET, tabIsDirty: false },
        client: oversizedClient,
        workspaceAuthority: WORKSPACE_AUTHORITY,
        nativeAuthority: {}
      })
    ).resolves.toMatchObject({
      editable: false,
      readOnlyReason: MARKDOWN_TOO_LARGE_READ_ONLY_REASON,
      contentBase64: Buffer.from('x'.repeat(MOBILE_MARKDOWN_EDIT_MAX_BYTES)).toString('base64')
    })

    await expect(
      executeMobileWebMarkdownOperation({
        operation: 'markdownSave',
        payload: {
          ...PAGE_TARGET,
          baseVersion: 'v1',
          contentBase64: Buffer.from('x'.repeat(MOBILE_MARKDOWN_EDIT_MAX_BYTES + 1)).toString(
            'base64'
          )
        },
        client: rpcClient(vi.fn().mockResolvedValue(tabsResponse())),
        workspaceAuthority: WORKSPACE_AUTHORITY,
        nativeAuthority: {}
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })

    const draftRead = vi.fn().mockResolvedValue({ content: 'draft', baseVersion: 'v1' })
    const result = await executeMobileWebMarkdownOperation({
      operation: 'markdownDraftRead',
      payload: PAGE_TARGET,
      client: rpcClient(vi.fn().mockResolvedValue(tabsResponse())),
      workspaceAuthority: WORKSPACE_AUTHORITY,
      nativeAuthority: {
        sessionMarkdownDraftRead: draftRead
      } as MobileWebNativeCapabilityAuthority
    })
    expect(draftRead).toHaveBeenCalledWith(
      HOST_WORKSPACE_ID,
      PAGE_TARGET.tabId,
      PAGE_TARGET.relativePath
    )
    expect(result).toMatchObject({
      ...PAGE_TARGET,
      draft: {
        contentBase64: Buffer.from('draft').toString('base64'),
        baseVersion: 'v1'
      }
    })
  })
})

function tabsResponse(override: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      worktree: HOST_WORKSPACE_ID,
      tabs: [
        {
          type: 'markdown',
          id: PAGE_TARGET.tabId,
          relativePath: PAGE_TARGET.relativePath
        }
      ],
      ...override
    }
  }
}

function rpcClient(sendRequest: ReturnType<typeof vi.fn>): RpcClient {
  return { sendRequest } as unknown as RpcClient
}
