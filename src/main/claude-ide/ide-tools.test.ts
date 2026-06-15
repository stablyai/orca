import { describe, it, expect, vi } from 'vitest'
import { handleToolCall } from './ide-tools'
import type { IdeBridge } from './ide-tools'

function bridge(overrides: Partial<IdeBridge> = {}): IdeBridge {
  return {
    openDiff: vi.fn().mockResolvedValue('keep'),
    openFile: vi.fn().mockResolvedValue(undefined),
    getWorkspaceFolders: vi.fn().mockResolvedValue(['/w']),
    getCurrentSelection: vi.fn().mockResolvedValue({ text: 'x', filePath: '/w/a.ts' }),
    getOpenEditors: vi.fn().mockResolvedValue([{ filePath: '/w/a.ts', isDirty: false }]),
    checkDocumentDirty: vi.fn().mockResolvedValue(false),
    saveDocument: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('handleToolCall', () => {
  it('openDiff returns a Keep/Reject MCP content result', async () => {
    const b = bridge()
    const res = await handleToolCall(b, 'openDiff', { old_file_path: '/w/a.ts', new_file_path: '/w/a.ts', new_file_contents: 'y' })
    expect(b.openDiff).toHaveBeenCalled()
    expect(res).toEqual({ content: [{ type: 'text', text: 'keep' }] })
  })

  it('getWorkspaceFolders returns folders', async () => {
    const res = await handleToolCall(bridge(), 'getWorkspaceFolders', {})
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(['/w']) }] })
  })

  it('throws on unknown tool', async () => {
    await expect(handleToolCall(bridge(), 'nope', {})).rejects.toThrow('Unknown tool')
  })
})
