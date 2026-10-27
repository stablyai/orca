import { describe, expect, it, vi } from 'vitest'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../runtime-layout-apply'
import {
  openEditorFileThroughLayoutOwner,
  type EditorOpenHost
} from './editor-open-through-layout-owner'

const OPEN = { worktreeId: 'wt', filePath: '/repo/src/a.ts', relativePath: 'src/a.ts' }

function host(replies: LayoutApplyReply[], groupId?: string) {
  const sent: WindowLayoutCommand[] = []
  const reveal = vi.fn()
  const openInWindow = vi.fn()
  const value: EditorOpenHost = {
    applyLayoutCommand: async (command) => {
      sent.push(command)
      return replies.shift() ?? { ok: true, result: {} }
    },
    groupFor: () => groupId,
    revealEditorTab: reveal,
    openInWindow
  }
  return { value, sent, reveal, openInWindow }
}

describe('a file main opens itself', () => {
  it("writes the tab in the window's reported group, then shows it at its frame", async () => {
    const h = host([{ ok: true, result: { tabId: 'main-tab' }, frameSeq: 7 }], 'g2')
    await openEditorFileThroughLayoutOwner(h.value, OPEN)
    expect(h.sent).toEqual([
      expect.objectContaining({
        type: 'openEditorTab',
        workspace: 'wt',
        contentType: 'editor',
        groupId: 'g2',
        file: { filePath: '/repo/src/a.ts', relativePath: 'src/a.ts', language: 'typescript' }
      })
    ])
    expect(h.sent[0]).not.toHaveProperty('fileId')
    expect(h.reveal).toHaveBeenCalledWith({ ...OPEN, tabId: 'main-tab', frameSeq: 7 })
  })

  it('opens by main’s own rule when the reported group has closed', async () => {
    const h = host(
      [
        { ok: false, code: 'group_not_found' },
        { ok: true, result: { tabId: 'main-tab' } }
      ],
      'gone'
    )
    await openEditorFileThroughLayoutOwner(h.value, OPEN)
    expect(h.sent[1]).not.toHaveProperty('groupId')
    expect(h.reveal).toHaveBeenCalledOnce()
  })

  it('opens through the window for a workspace a paired server owns', async () => {
    const h = host([{ ok: false, code: 'host_not_owned' }])
    await openEditorFileThroughLayoutOwner(h.value, OPEN)
    expect(h.openInWindow).toHaveBeenCalledWith(OPEN)
    expect(h.reveal).not.toHaveBeenCalled()
  })

  it('fails the open main refused', async () => {
    const h = host([{ ok: false, code: 'workspace_not_found' }])
    await expect(openEditorFileThroughLayoutOwner(h.value, OPEN)).rejects.toThrow(
      'editor_open_refused: workspace_not_found'
    )
  })

  it('needs no window', async () => {
    const h = host([{ ok: true, result: { tabId: 'main-tab' } }])
    const { revealEditorTab: _none, ...headless } = h.value
    await expect(openEditorFileThroughLayoutOwner(headless, OPEN)).resolves.toBeUndefined()
  })
})
