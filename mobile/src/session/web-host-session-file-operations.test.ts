import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSessionFileOperations } from './web-host-session-file-operations'

describe('web host session file operations', () => {
  it('reads text through the strict file bridge', async () => {
    const fileRead = vi.fn().mockResolvedValue({
      workspaceId: 'workspace_opaque',
      relativePath: 'src/app.ts',
      content: 'export const value = 1\\n',
      truncated: false,
      byteLength: 23
    })
    const operations = webHostSessionFileOperations({ fileRead } as never)

    await expect(
      operations.readTab({
        worktreeId: 'workspace_opaque',
        relativePath: 'src/app.ts'
      })
    ).resolves.toEqual({
      status: 'ready',
      kind: 'file',
      content: 'export const value = 1\\n',
      truncated: false,
      byteLength: 23
    })
    expect(fileRead).toHaveBeenCalledWith({
      workspaceId: 'workspace_opaque',
      relativePath: 'src/app.ts'
    })
  })

  it('assembles bounded source-control diff pages for the existing diff UI', async () => {
    const sourceControlDiff = vi
      .fn<MobileWebBridgeClient['sourceControlDiff']>()
      .mockResolvedValueOnce({
        workspaceId: 'workspace_opaque',
        relativePath: 'src/app.ts',
        area: 'unstaged',
        kind: 'text',
        revision: 'a'.repeat(64),
        offset: 0,
        totalRows: 2,
        rows: [
          {
            index: 0,
            kind: 'delete',
            text: 'before',
            textTruncated: false,
            oldLineNumber: 1
          }
        ],
        nextOffset: 1,
        truncated: false
      })
      .mockResolvedValueOnce({
        workspaceId: 'workspace_opaque',
        relativePath: 'src/app.ts',
        area: 'unstaged',
        kind: 'text',
        revision: 'a'.repeat(64),
        offset: 1,
        totalRows: 2,
        rows: [
          {
            index: 1,
            kind: 'add',
            text: 'after',
            textTruncated: false,
            newLineNumber: 1
          }
        ],
        nextOffset: null,
        truncated: false
      })
    const operations = webHostSessionFileOperations({ sourceControlDiff } as never)

    await expect(
      operations.readTab({
        worktreeId: 'workspace_opaque',
        relativePath: 'src/app.ts',
        diffSource: 'unstaged'
      })
    ).resolves.toEqual({
      status: 'ready',
      kind: 'diff',
      lines: [
        { kind: 'delete', text: 'before', oldLineNumber: 1 },
        { kind: 'add', text: 'after', newLineNumber: 1 }
      ],
      truncated: false
    })
    expect(sourceControlDiff).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 1, expectedRevision: 'a'.repeat(64) })
    )
  })
})
