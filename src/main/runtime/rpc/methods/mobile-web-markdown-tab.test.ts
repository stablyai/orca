import { describe, expect, it, vi } from 'vitest'
import { MARKDOWN_TOO_LARGE_READ_ONLY_REASON } from '../../../../shared/mobile-markdown-disk-fallback'
import { MOBILE_MARKDOWN_EDIT_MAX_BYTES } from '../../../../shared/mobile-markdown-document'
import type { RpcContext } from '../core'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'
import { MOBILE_WEB_MARKDOWN_TAB_METHODS } from './mobile-web-markdown-tab'

const [read, save] = MOBILE_WEB_MARKDOWN_TAB_METHODS
const decode = (value: unknown) =>
  Buffer.from((value as { contentBase64: string }).contentBase64, 'base64').toString('utf8')

function fixture(relativePath = 'notes.md') {
  const runtime = {
    listMobileSessionTabs: vi.fn().mockResolvedValue({
      worktree: 'workspace-1',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      tabs: [{ id: 'tab-1', type: 'markdown', relativePath }]
    }),
    readMobileMarkdownTab: vi.fn().mockResolvedValue({
      tabId: 'tab-1',
      relativePath,
      content: '# Notes',
      version: 'v1',
      isDirty: false,
      editable: true
    }),
    saveMobileMarkdownTab: vi
      .fn()
      .mockResolvedValue({ tabId: 'tab-1', version: 'v2', isDirty: false, content: 'saved' }),
    readMobileFile: vi.fn().mockResolvedValue({ relativePath, content: '# Disk', truncated: false })
  }
  return { runtime, context: { runtime } as unknown as RpcContext }
}

const target = { worktree: 'id:workspace-1', tabId: 'tab-1', relativePath: 'notes.md' }

describe('mobile web markdown tabs', () => {
  it('reads the tab the host owns and echoes only a worktree-relative path', async () => {
    const f = fixture()
    expect(await read.handler({ ...target, tabIsDirty: false }, f.context)).toEqual({
      tabId: 'tab-1',
      relativePath: 'notes.md',
      contentBase64: Buffer.from('# Notes', 'utf8').toString('base64'),
      baseVersion: 'v1',
      editable: true,
      stale: false
    })
  })

  it('omits the path for a tab opened from outside the worktree', async () => {
    const f = fixture('/outside/notes.md')
    const result = await read.handler(
      { worktree: 'id:workspace-1', tabId: 'tab-1', tabIsDirty: false },
      f.context
    )
    expect(result).not.toHaveProperty('relativePath')
    expect(JSON.stringify(result)).not.toContain('/outside')
  })

  it('refuses a page path that no longer names the tab', async () => {
    const f = fixture('renamed.md')
    await expect(read.handler({ ...target, tabIsDirty: false }, f.context)).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('falls back to disk, read-only, when no renderer owns the tab', async () => {
    const f = fixture()
    f.runtime.readMobileMarkdownTab.mockRejectedValue(new Error('renderer_unavailable'))
    const result = await read.handler({ ...target, tabIsDirty: true }, f.context)
    expect(decode(result)).toBe('# Disk')
    expect(result).toMatchObject({
      baseVersion: '',
      editable: false,
      stale: true,
      readOnlyReason: 'Desktop has unsaved changes. Showing disk content.'
    })
  })

  it('clips a document past the edit ceiling and serves it read-only', async () => {
    const f = fixture()
    f.runtime.readMobileMarkdownTab.mockResolvedValue({
      tabId: 'tab-1',
      relativePath: 'notes.md',
      content: 'λ'.repeat(MOBILE_MARKDOWN_EDIT_MAX_BYTES),
      version: 'v1',
      isDirty: false,
      editable: true
    })
    const result = await read.handler({ ...target, tabIsDirty: false }, f.context)
    expect(Buffer.from(decode(result), 'utf8').byteLength).toBeLessThanOrEqual(
      MOBILE_MARKDOWN_EDIT_MAX_BYTES
    )
    // A split UTF-8 sequence would decode to a replacement character.
    expect(decode(result)).not.toContain('�')
    expect(result).toMatchObject({
      editable: false,
      readOnlyReason: MARKDOWN_TOO_LARGE_READ_ONLY_REASON
    })
  })

  it('saves and answers the version the host stored', async () => {
    const f = fixture()
    expect(
      await save.handler(
        { ...target, baseVersion: 'v1', contentBase64: Buffer.from('edit').toString('base64') },
        f.context
      )
    ).toEqual({
      outcome: 'saved',
      tabId: 'tab-1',
      relativePath: 'notes.md',
      contentBase64: Buffer.from('saved').toString('base64'),
      baseVersion: 'v2'
    })
    expect(f.runtime.saveMobileMarkdownTab).toHaveBeenCalledWith(
      'id:workspace-1',
      'tab-1',
      'v1',
      'edit'
    )
  })

  it('reports a stale base version as an outcome the page can act on', async () => {
    const f = fixture()
    f.runtime.saveMobileMarkdownTab.mockRejectedValue(new Error('conflict'))
    expect(
      await save.handler(
        { ...target, baseVersion: 'v0', contentBase64: Buffer.from('edit').toString('base64') },
        f.context
      )
    ).toEqual({ outcome: 'conflict' })
  })

  it('is reachable from a mobile socket', () => {
    for (const method of MOBILE_WEB_MARKDOWN_TAB_METHODS) {
      expect(isMobileWebHostRpcMethod(method.name), method.name).toBe(true)
    }
  })
})
