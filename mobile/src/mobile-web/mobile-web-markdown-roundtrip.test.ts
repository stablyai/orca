import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

describe('mobile web markdown round trip', () => {
  it('resolves page workspace authority before host reads and shell draft persistence', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({ worktrees: [{ worktreeId: 'host-workspace', repoId: 'host-repo' }] })
      )
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(
        success({
          tabId: 'host-tab',
          filePath: '/secret/worktree/notes.md',
          relativePath: 'notes.md',
          content: 'host content',
          isDirty: false,
          version: 'v1',
          source: 'file',
          editable: true
        })
      )
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(success(sessionSnapshot()))
    const sessionMarkdownDraftRead = vi
      .fn()
      .mockResolvedValue({ content: 'phone draft', baseVersion: 'v1' })
    const sessionMarkdownDraftWrite = vi.fn().mockResolvedValue(undefined)
    const rpcClient = { sendRequest } as unknown as RpcClient
    let requestIndex = 0
    const { client } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
      rpcClient,
      createRequestId: () => `${String.fromCharCode(65 + requestIndex++)}`.repeat(22),
      nativeAuthority: {
        sessionMarkdownDraftRead,
        sessionMarkdownDraftWrite
      },
      terminalClientId: 'device'
    })

    const workspace = (await client.workspaceSnapshot({ limit: 1 })).workspaces[0]!
    const session = await client.sessionSnapshot({ workspaceId: workspace.id })
    const tab = session.tabs[0]!
    expect(tab).toMatchObject({ type: 'markdown', relativePath: 'notes.md' })

    const readResult = await client.markdown.read({
      workspaceId: workspace.id,
      tabId: tab.id,
      relativePath: 'notes.md',
      tabIsDirty: false
    })
    expect(readResult).toMatchObject({
      content: 'host content',
      baseVersion: 'v1',
      editable: true
    })
    const draftResult = await client.markdown.loadDraft({
      workspaceId: workspace.id,
      tabId: tab.id,
      relativePath: 'notes.md'
    })
    expect(draftResult).toEqual({ content: 'phone draft', baseVersion: 'v1' })
    await client.markdown.saveDraft({
      workspaceId: workspace.id,
      tabId: tab.id,
      relativePath: 'notes.md',
      draft: { content: 'next draft', baseVersion: 'v1' }
    })

    expect(sessionMarkdownDraftRead).toHaveBeenCalledWith('host-workspace', 'host-tab', 'notes.md')
    expect(sessionMarkdownDraftWrite).toHaveBeenCalledWith(
      'host-workspace',
      'host-tab',
      'notes.md',
      { content: 'next draft', baseVersion: 'v1' }
    )
    expect(workspace.id).not.toBe('host-workspace')
    expect(JSON.stringify({ readResult, draftResult })).not.toContain('/secret/worktree')
  })
})

function sessionSnapshot() {
  return {
    worktree: 'host-workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeTabId: 'host-tab',
    activeTabType: 'markdown',
    tabs: [
      {
        type: 'markdown',
        id: 'host-tab',
        title: 'notes.md',
        filePath: '/secret/worktree/notes.md',
        relativePath: 'notes.md',
        isDirty: false,
        isActive: true,
        documentVersion: 'v1'
      }
    ]
  }
}

function success(result: unknown) {
  return {
    id: 'response',
    ok: true as const,
    result,
    _meta: { runtimeId: 'runtime' }
  }
}
