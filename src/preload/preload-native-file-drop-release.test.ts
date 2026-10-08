// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OS_FILE_DROP_OWNER_ATTRIBUTE } from '../shared/native-file-drop-preparation'
import { ORCA_INTERNAL_FILE_DRAG_TYPE } from '../shared/native-file-drop'

const electron = vi.hoisted(() => ({
  send: vi.fn(),
  getPathForFile: vi.fn((file: File) => `/drop/${file.name}`),
  on: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('electron', () => ({
  ipcRenderer: electron,
  webUtils: { getPathForFile: electron.getPathForFile }
}))
import { installNativeFileDropHandlers } from './preload-runtime-support'

function dispatch(target: Element, type = 'drop', types = ['Files']) {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
  const transfer = { types, files: [new File(['x'], 'notes.txt')], dropEffect: 'none' }
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  const stop = vi.spyOn(event, 'stopPropagation')
  target.dispatchEvent(event)
  return { event, transfer, stop }
}

function root(owner: boolean, legacy = false) {
  const element = document.createElement('div')
  if (owner) {
    element.setAttribute(OS_FILE_DROP_OWNER_ATTRIBUTE, '')
  }
  if (legacy) {
    element.dataset.nativeFileDropTarget = 'terminal'
  }
  document.body.append(element)
  return element
}

beforeAll(() => {
  installNativeFileDropHandlers()
  installNativeFileDropHandlers()
})
beforeEach(() => {
  document.body.replaceChildren()
  electron.send.mockClear()
  electron.getPathForFile.mockClear()
})

describe('preload migration release', () => {
  it.each([false, true])(
    'keeps unmarked and legacy roots on the relay exactly once: legacy=%s',
    (legacy) => {
      const { event, stop } = dispatch(root(false, legacy))
      expect(event.defaultPrevented).toBe(true)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(electron.send).toHaveBeenCalledExactlyOnceWith('terminal:file-dropped-from-preload', {
        paths: ['/drop/notes.txt'],
        target: legacy ? 'terminal' : 'editor'
      })
    }
  )

  it.each(['drop', 'dragover'])('leaves %s inside a migrated owner untouched', (type) => {
    const owner = root(true)
    const child = document.createElement('span')
    owner.append(child)
    const { event, transfer, stop } = dispatch(child, type)
    expect(event.defaultPrevented).toBe(false)
    expect(stop).not.toHaveBeenCalled()
    expect(transfer.dropEffect).toBe('none')
    expect(electron.send).not.toHaveBeenCalled()
    expect(electron.getPathForFile).not.toHaveBeenCalled()
  })

  it.each(['drop', 'dragover'])('keeps a nested legacy boundary on the legacy %s path', (type) => {
    const owner = root(true)
    const legacy = root(false, true)
    owner.append(legacy)
    const { event, transfer } = dispatch(legacy, type)
    expect(event.defaultPrevented).toBe(true)
    if (type === 'drop') {
      expect(electron.send).toHaveBeenCalledExactlyOnceWith('terminal:file-dropped-from-preload', {
        paths: ['/drop/notes.txt'],
        target: 'terminal'
      })
    } else {
      expect(transfer.dropEffect).toBe('copy')
      expect(electron.send).not.toHaveBeenCalled()
    }
  })

  it('chooses an inner owner over an outer legacy boundary', () => {
    const legacy = root(false, true)
    const owner = root(true)
    legacy.append(owner)
    expect(dispatch(owner).event.defaultPrevented).toBe(false)
    expect(electron.send).not.toHaveBeenCalled()
  })

  it.each(['drop', 'dragover'])(
    'leaves internal %s unchanged even inside a migrated owner',
    (type) => {
      const { event, transfer, stop } = dispatch(root(true), type, [
        'Files',
        ORCA_INTERNAL_FILE_DRAG_TYPE
      ])
      expect(event.defaultPrevented).toBe(false)
      expect(stop).not.toHaveBeenCalled()
      expect(transfer.dropEffect).toBe('none')
      expect(electron.send).not.toHaveBeenCalled()
    }
  )

  it('keeps the existing non-file drop cancellation, regardless of owner markers', () => {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/plain'], files: [] } })
    root(true).dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(electron.send).not.toHaveBeenCalled()
    expect(dispatch(root(true), 'dragover', ['text/plain']).event.defaultPrevented).toBe(false)
  })
})
