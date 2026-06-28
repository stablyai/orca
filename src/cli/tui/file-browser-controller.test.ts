import { describe, expect, it, vi } from 'vitest'
import { FileBrowserController } from './file-browser-controller'

type Call = { method: string; params: unknown }

function setup(files = [{ relativePath: 'src/a.ts', basename: 'a.ts' }]) {
  const calls: Call[] = []
  const client = {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params })
      return { result: method === 'files.list' ? { files } : {} }
    })
  }
  const onOpened = vi.fn()
  const fb = new FileBrowserController(client as never, {
    worktreeId: () => 'wt-1',
    bodyHeight: () => 20,
    onChange: () => {},
    onOpened
  })
  return { fb, calls, client, onOpened }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('FileBrowserController', () => {
  it('toggles open (loading files) then closed', async () => {
    const { fb, calls } = setup()
    fb.toggle()
    await flush()
    expect(fb.isOpen).toBe(true)
    expect(calls.some((c) => c.method === 'files.list')).toBe(true)
    expect(fb.current.files).toHaveLength(1)
    fb.toggle()
    expect(fb.isOpen).toBe(false)
  })

  it('closes on f and on Escape', async () => {
    const { fb } = setup()
    fb.toggle()
    await flush()
    fb.handleKey('f')
    expect(fb.isOpen).toBe(false)

    fb.toggle()
    await flush()
    fb.handleKey('\x1b')
    expect(fb.isOpen).toBe(false)
  })

  it('expands a folder with → and opens a file with Enter', async () => {
    const { fb, calls, onOpened } = setup()
    fb.toggle()
    await flush()
    // Top row is the folder "src" (collapsed). → expands it.
    fb.handleKey('\x1b[C')
    expect(fb.current.expanded.has('src')).toBe(true)
    // ↓ to the file, Enter opens it.
    fb.handleKey('\x1b[B')
    fb.handleKey('\r')
    await flush()
    expect(calls.some((c) => c.method === 'files.open')).toBe(true)
    expect(onOpened).toHaveBeenCalledWith('src/a.ts')
  })

  it('does not call onOpened when files.open fails', async () => {
    const { fb, client, onOpened } = setup()
    fb.toggle()
    await flush()
    client.call.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    fb.handleKey('\x1b[C') // expand src
    fb.handleKey('\x1b[B') // select file
    fb.handleKey('\r') // open → rejects
    await flush()
    expect(onOpened).not.toHaveBeenCalled()
    expect(fb.isOpen).toBe(false)
  })
})
