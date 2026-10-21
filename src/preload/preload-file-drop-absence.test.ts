// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn() }
}))

it('registers no document drop or dragover listeners in preload', async () => {
  const addListener = vi.spyOn(document, 'addEventListener')
  try {
    const preload = await import('./preload-runtime-support')
    if (
      'installNativeFileDropHandlers' in preload &&
      typeof preload.installNativeFileDropHandlers === 'function'
    ) {
      preload.installNativeFileDropHandlers()
    }
    expect(
      addListener.mock.calls.filter(([type]) => type === 'drop' || type === 'dragover')
    ).toEqual([])
  } finally {
    addListener.mockRestore()
  }
})
