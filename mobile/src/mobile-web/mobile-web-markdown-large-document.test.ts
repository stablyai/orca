import { describe, expect, it, vi } from 'vitest'
import { MOBILE_MARKDOWN_EDIT_MAX_BYTES } from '../../../src/shared/mobile-markdown-document'
import { MARKDOWN_TOO_LARGE_READ_ONLY_REASON } from '../session/mobile-markdown-disk-fallback'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

// Why: a multi-byte tail proves the clamp cannot split a UTF-8 sequence.
const OVERSIZED_CONTENT = `${'a'.repeat(MOBILE_MARKDOWN_EDIT_MAX_BYTES - 1)}\u00e9\u00e9`

function hostTabsList() {
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
        filePath: '/repo/docs/notes.md',
        relativePath: 'docs/notes.md',
        language: 'markdown',
        mode: 'edit',
        isDirty: false,
        isActive: true,
        documentVersion: 'file:file-1'
      }
    ]
  }
}

function readTabResult(content: string) {
  return {
    tabId: 'host-tab',
    filePath: '/repo/docs/notes.md',
    relativePath: 'docs/notes.md',
    content,
    isDirty: false,
    version: 'content:v1',
    source: 'file',
    editable: false,
    readOnlyReason: 'file_too_large'
  }
}

async function readOversizedMarkdown(readTabFails = false) {
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'session.tabs.list') {
      return { ok: true as const, result: hostTabsList() }
    }
    if (method === 'markdown.readTab') {
      return readTabFails
        ? { ok: false as const, error: { code: 'renderer_unavailable', message: 'x' } }
        : { ok: true as const, result: readTabResult(OVERSIZED_CONTENT) }
    }
    if (method === 'files.read') {
      return {
        ok: true as const,
        result: {
          worktree: 'host-workspace',
          relativePath: 'docs/notes.md',
          content: OVERSIZED_CONTENT,
          truncated: false
        }
      }
    }
    return {
      ok: true as const,
      result: { worktrees: [{ worktreeId: 'host-workspace', repoId: 'host-repo' }] }
    }
  })
  let index = 0
  const { client } = createMobileWebBridgeRoundtripFixture({
    grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
    rpcClient: { sendRequest } as unknown as RpcClient,
    createRequestId: () => `${String.fromCharCode(65 + (index++ % 26))}`.repeat(22),
    terminalClientId: 'device'
  })
  const workspace = (await client.workspaceSnapshot({ limit: 1 })).workspaces[0]!
  return client.markdown.read({
    workspaceId: workspace.id,
    tabId: 'host-tab',
    relativePath: 'docs/notes.md',
    tabIsDirty: false
  })
}

describe('hosted markdown read of a document past the edit ceiling', () => {
  it('serves it read-only instead of failing the tab', async () => {
    const result = await readOversizedMarkdown()
    expect(result.editable).toBe(false)
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(
      MOBILE_MARKDOWN_EDIT_MAX_BYTES
    )
    expect(result.readOnlyReason).toBe(MARKDOWN_TOO_LARGE_READ_ONLY_REASON)
    // Both trailing multi-byte characters drop out rather than being cut in half.
    expect(result.content.length).toBe(MOBILE_MARKDOWN_EDIT_MAX_BYTES - 1)
    expect(result.content.endsWith('\u00e9')).toBe(false)
  })

  it('serves it read-only through the disk fallback too', async () => {
    const result = await readOversizedMarkdown(true)
    expect(result.editable).toBe(false)
    expect(result.readOnlyReason).toBe(MARKDOWN_TOO_LARGE_READ_ONLY_REASON)
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(
      MOBILE_MARKDOWN_EDIT_MAX_BYTES
    )
  })
})
