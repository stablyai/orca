import { describe, expect, it, vi } from 'vitest'
import { saveFileTab } from './file-save'
import { FileEditor } from './file-editor'

function editorWith(content: string): FileEditor {
  const editor = new FileEditor()
  editor.load(content)
  return editor
}

// A fake client. files.writeIfUnchanged returns the runtime CAS verdict; the
// non-overwrite path uses it, the overwrite path uses files.write.
function fakeClient(
  status: 'saved' | 'conflict',
  calls: { method: string; params: unknown }[] = []
) {
  return {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params })
      return { result: method === 'files.writeIfUnchanged' ? { status } : {} }
    })
  }
}

describe('saveFileTab', () => {
  it('compare-and-swaps with the loaded baseline and marks saved', async () => {
    const calls: { method: string; params: unknown }[] = []
    const editor = editorWith('hello')
    editor.handleKey({ type: 'char', value: '!' }) // buffer "!hello", baseline "hello"
    const client = fakeClient('saved', calls)
    const result = await saveFileTab(client as never, 'id:wt', 'a.txt', editor, false)
    expect(result).toBe('saved')
    expect(calls).toEqual([
      {
        method: 'files.writeIfUnchanged',
        params: {
          worktree: 'id:wt',
          relativePath: 'a.txt',
          content: '!hello',
          expectedContent: 'hello'
        }
      }
    ])
    expect(editor.dirty).toBe(false)
  })

  it('reports a conflict when the runtime CAS rejects the write', async () => {
    const calls: { method: string; params: unknown }[] = []
    const editor = editorWith('hello')
    const client = fakeClient('conflict', calls)
    const result = await saveFileTab(client as never, 'id:wt', 'a.txt', editor, false)
    expect(result).toBe('conflict')
    expect(calls.every((c) => c.method !== 'files.write')).toBe(true)
  })

  it('force-overwrites via files.write when allowOverwrite is set', async () => {
    const calls: { method: string; params: unknown }[] = []
    const editor = editorWith('hello')
    const client = fakeClient('saved', calls)
    const result = await saveFileTab(client as never, 'id:wt', 'a.txt', editor, true)
    expect(result).toBe('saved')
    expect(calls.map((c) => c.method)).toEqual(['files.write'])
  })

  it('falls back to read-then-write when files.writeIfUnchanged is unavailable', async () => {
    const calls: string[] = []
    const editor = editorWith('hello')
    const client = {
      call: vi.fn(async (method: string) => {
        calls.push(method)
        if (method === 'files.writeIfUnchanged') {
          throw new Error('Unknown method')
        }
        return { result: { content: 'hello' } } // disk still matches baseline
      })
    }
    const result = await saveFileTab(client as never, 'id:wt', 'a.txt', editor, false)
    expect(result).toBe('saved')
    expect(calls).toEqual(['files.writeIfUnchanged', 'files.read', 'files.write'])
  })

  it('surfaces a non-method CAS error as failed (no fallback)', async () => {
    const calls: string[] = []
    const editor = editorWith('hello')
    const client = {
      call: vi.fn(async (method: string) => {
        calls.push(method)
        throw new Error('permission denied')
      })
    }
    expect(await saveFileTab(client as never, 'id:wt', 'a.txt', editor, false)).toBe('failed')
    expect(calls).toEqual(['files.writeIfUnchanged']) // no read/write fallback
  })

  it('reports a conflict on the fallback path when the disk diverged', async () => {
    const editor = editorWith('hello')
    const client = {
      call: vi.fn(async (method: string) => {
        if (method === 'files.writeIfUnchanged') {
          throw new Error('Unknown method')
        }
        return { result: { content: 'changed elsewhere' } }
      })
    }
    expect(await saveFileTab(client as never, 'id:wt', 'a.txt', editor, false)).toBe('conflict')
  })
})
