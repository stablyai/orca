import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { mobileWebSessionTabPresentation } from '../session/mobile-web-session-tab-presentation'
import { webHostSessionMarkdownOperations } from '../session/web-host-session-markdown-operations'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

// The desktop records tabs for files opened outside the worktree with an absolute path in both
// `filePath` and `relativePath`; the page can never name such a path itself.
const HOST_PATH = '/Users/jinwoo/stably/relay-split-checklist.md'

function hostTabsList() {
  return {
    worktree: 'host-workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 4,
    activeTabId: 'unified-tab-1',
    activeTabType: 'markdown',
    tabs: [
      {
        type: 'markdown',
        id: 'unified-tab-1',
        title: 'relay-split-checklist.md',
        filePath: HOST_PATH,
        relativePath: HOST_PATH,
        language: 'markdown',
        mode: 'edit',
        isDirty: true,
        isActive: true,
        sourceRelativePath: HOST_PATH,
        documentVersion: 'file:file-1'
      }
    ]
  }
}

function fixture() {
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'session.tabs.list') {
      return { ok: true as const, result: hostTabsList() }
    }
    if (method === 'markdown.readTab') {
      return {
        ok: true as const,
        result: {
          tabId: 'unified-tab-1',
          filePath: HOST_PATH,
          relativePath: HOST_PATH,
          content: '# checklist',
          isDirty: true,
          version: 'content:v1',
          source: 'file',
          editable: true
        }
      }
    }
    if (method === 'markdown.saveTab') {
      return {
        ok: true as const,
        result: {
          tabId: 'unified-tab-1',
          version: 'content:v2',
          isDirty: false,
          content: '# edited'
        }
      }
    }
    return {
      ok: true as const,
      result: { worktrees: [{ worktreeId: 'host-workspace', repoId: 'host-repo' }] }
    }
  })
  const draftRead = vi.fn().mockResolvedValue(null)
  const draftWrite = vi.fn().mockResolvedValue(undefined)
  let index = 0
  const { client } = createMobileWebBridgeRoundtripFixture({
    grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
    rpcClient: { sendRequest } as unknown as RpcClient,
    createRequestId: () => `${String.fromCharCode(65 + (index++ % 26))}`.repeat(22),
    nativeAuthority: {
      sessionMarkdownDraftRead: draftRead,
      sessionMarkdownDraftWrite: draftWrite
    },
    terminalClientId: 'device'
  })
  return { client, draftRead, draftWrite, sendRequest }
}

describe('hosted markdown tab whose host path is outside the worktree', () => {
  it('reads, saves and scopes drafts by tab id without the page naming a path', async () => {
    const { client, draftRead, draftWrite } = fixture()
    const workspace = (await client.workspaceSnapshot({ limit: 1 })).workspaces[0]!
    const snapshot = await client.sessionSnapshot({ workspaceId: workspace.id })
    const presented = mobileWebSessionTabPresentation(snapshot)
    const tab = presented.tabs[0]!
    if (tab.type !== 'markdown') {
      throw new Error(`unexpected tab type ${tab.type}`)
    }
    expect(tab.isDirty).toBe(true)

    const operations = webHostSessionMarkdownOperations(client)
    const target = {
      workspaceId: workspace.id,
      tabId: tab.id,
      relativePath: tab.relativePath
    }
    await expect(operations.readTab({ ...target, tabIsDirty: tab.isDirty })).resolves.toMatchObject(
      {
        status: 'ready',
        content: '# checklist',
        editable: true
      }
    )
    await expect(
      operations.saveTab({ ...target, content: '# edited', baseVersion: 'content:v1' })
    ).resolves.toMatchObject({ content: '# edited', baseVersion: 'content:v2' })

    await operations.loadDraft(target)
    await operations.saveDraft(target, { content: 'draft', baseVersion: 'content:v1' })
    // The shell resolves the host path itself, so drafts stay scoped to the real file.
    expect(draftRead).toHaveBeenCalledWith('host-workspace', 'unified-tab-1', HOST_PATH)
    expect(draftWrite).toHaveBeenCalledWith('host-workspace', 'unified-tab-1', HOST_PATH, {
      content: 'draft',
      baseVersion: 'content:v1'
    })
  })

  it('never hands the host path to the page', async () => {
    const { client } = fixture()
    const workspace = (await client.workspaceSnapshot({ limit: 1 })).workspaces[0]!
    const snapshot = await client.sessionSnapshot({ workspaceId: workspace.id })
    const read = await client.markdown.read({
      workspaceId: workspace.id,
      tabId: 'unified-tab-1',
      tabIsDirty: true
    })
    expect(JSON.stringify({ snapshot, read })).not.toContain('/Users/jinwoo')
  })
})
