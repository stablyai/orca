import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorPopoutOpenRequest } from '../../shared/editor-popout'

const { instances, BrowserWindowMock, showMessageBoxMock, translateMainMock } = vi.hoisted(() => {
  const created: FakeWindow[] = []
  let nextWebContentsId = 100

  class FakeWindow {
    options: Electron.BrowserWindowConstructorOptions
    private handlers = new Map<string, ((...args: unknown[]) => void)[]>()
    destroyed = false
    minimized = false
    webContents = {
      id: nextWebContentsId++,
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn()
      },
      send: vi.fn(),
      on: vi.fn(),
      isDestroyed: vi.fn(() => false)
    }
    focus = vi.fn()
    restore = vi.fn(() => {
      this.minimized = false
    })
    show = vi.fn()
    loadFile = vi.fn()
    loadURL = vi.fn()

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.options = options
      created.push(this)
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const handlers = this.handlers.get(event) ?? []
      handlers.push(handler)
      this.handlers.set(event, handlers)
      return this
    }

    once(event: string, handler: (...args: unknown[]) => void): this {
      return this.on(event, handler)
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args)
      }
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    isMinimized(): boolean {
      return this.minimized
    }

    close = vi.fn(() => {
      let prevented = false
      this.emit('close', {
        preventDefault: vi.fn(() => {
          prevented = true
        })
      })
      if (prevented) {
        return
      }
      this.destroyed = true
      this.emit('closed')
    })
  }

  return {
    instances: created,
    BrowserWindowMock: FakeWindow,
    showMessageBoxMock: vi.fn(),
    translateMainMock: vi.fn((key: string) => `translated:${key}`)
  }
})

vi.mock('electron', () => ({
  BrowserWindow: BrowserWindowMock,
  dialog: { showMessageBox: showMessageBoxMock },
  nativeTheme: { shouldUseDarkColors: true }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../i18n/main-i18n', () => ({ translateMain: translateMainMock }))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: vi.fn()
}))

import {
  closeAllEditorPopouts,
  completeEditorPopoutSaveAndClose,
  createOrFocusEditorPopout,
  getEditorPopoutRequest,
  openEditorPopout,
  reportEditorPopoutCloseState,
  reportEditorPopoutReady,
  setEditorPopoutDirty
} from './editor-popout-window'

const request = {
  document: {
    id: '/workspace/note.md',
    filePath: '/workspace/note.md',
    relativePath: 'note.md',
    worktreeId: 'repo:main',
    language: 'markdown'
  },
  content: '# Draft\n',
  savedContent: '# Saved\n',
  viewMode: 'source',
  showFrontmatter: true,
  operationContext: {
    settings: { activeRuntimeEnvironmentId: null },
    worktreeId: 'repo:main',
    worktreePath: '/workspace',
    expectedExecutionHostId: 'local'
  }
} satisfies EditorPopoutOpenRequest

describe('editor popout window', () => {
  beforeEach(() => {
    instances.length = 0
    vi.clearAllMocks()
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
  })

  afterEach(() => {
    closeAllEditorPopouts()
    for (const window of instances) {
      if (!window.destroyed) {
        completeEditorPopoutSaveAndClose(window.webContents as never, true)
      }
    }
    vi.unstubAllEnvs()
  })

  it('creates a native detached editor and exposes state only to its renderer', () => {
    createOrFocusEditorPopout(request)
    const window = instances[0]

    expect(instances).toHaveLength(1)
    expect(window.options.title).toBe('note.md - Orca')
    expect(window.options.webPreferences?.partition).toBe('orca-editor-popout')
    expect(window.options.webPreferences?.preload).toContain('editor-popout.js')
    expect(window.loadFile).toHaveBeenCalledWith(expect.stringContaining('popout.html'), {
      search: 'surface=editor'
    })
    expect(getEditorPopoutRequest(window.webContents as never)).toEqual(request)
    expect(getEditorPopoutRequest({ id: 999 } as never)).toBeNull()
  })

  it('focuses the existing window for the same owned document', () => {
    createOrFocusEditorPopout(request)
    const first = instances[0]
    const second = createOrFocusEditorPopout(request)

    expect(second).toBe(first)
    expect(instances).toHaveLength(1)
    expect(first.focus).toHaveBeenCalledOnce()
  })

  it('acknowledges creation only after the detached renderer adopts state', async () => {
    const opened = openEditorPopout(request)
    let settled = false
    void opened.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    reportEditorPopoutReady(instances[0].webContents as never)

    await expect(opened).resolves.toEqual({ created: true })
  })

  it('rejects creation when the detached renderer never adopts state', async () => {
    vi.useFakeTimers()
    const opened = openEditorPopout(request)
    const rejected = expect(opened).rejects.toThrow('Detached editor did not become ready.')

    await vi.advanceTimersByTimeAsync(10_000)

    await rejected
    expect(instances[0].destroyed).toBe(true)
    vi.useRealTimers()
  })

  it('requests current renderer state before closing an initially clean document', () => {
    createOrFocusEditorPopout({
      ...request,
      content: request.savedContent
    })
    const window = instances[0]

    window.close()

    expect(window.destroyed).toBe(false)
    expect(window.webContents.send).toHaveBeenCalledWith('editorPopout:requestCloseState')

    reportEditorPopoutCloseState(window.webContents as never, false)

    expect(window.destroyed).toBe(true)
  })

  it('requires explicit discard when the renderer does not answer a close request', async () => {
    vi.useFakeTimers()
    try {
      showMessageBoxMock.mockResolvedValueOnce({ response: 1 })
      createOrFocusEditorPopout({
        ...request,
        content: request.savedContent
      })
      const window = instances[0]

      window.close()
      await vi.runAllTimersAsync()

      expect(window.destroyed).toBe(true)
      expect(showMessageBoxMock).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not bypass dirty protection when the main window closes', () => {
    createOrFocusEditorPopout(request)
    const window = instances[0]

    closeAllEditorPopouts()

    expect(window.destroyed).toBe(false)
    expect(window.webContents.send).toHaveBeenCalledWith('editorPopout:requestCloseState')
  })

  it('notifies the main window owner when a dirty popout cancels quit', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 1 })
    const onQuitAborted = vi.fn()
    createOrFocusEditorPopout(request)
    const window = instances[0]

    closeAllEditorPopouts(onQuitAborted)
    reportEditorPopoutCloseState(window.webContents as never, true)
    await Promise.resolve()

    expect(onQuitAborted).toHaveBeenCalledOnce()
    expect(window.destroyed).toBe(false)
  })

  it('asks the detached renderer to save before closing a dirty document', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    createOrFocusEditorPopout(request)
    const window = instances[0]
    setEditorPopoutDirty(window.webContents as never, true)
    const closeEvent = { preventDefault: vi.fn() }

    window.emit('close', closeEvent)
    reportEditorPopoutCloseState(window.webContents as never, true)
    await Promise.resolve()

    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(showMessageBoxMock).toHaveBeenCalledWith(window, {
      type: 'warning',
      buttons: [
        'translated:editorPopout.save',
        'translated:editorPopout.cancel',
        'translated:editorPopout.discard'
      ],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'translated:editorPopout.unsavedChanges',
      message: 'translated:editorPopout.closeConfirmTitle',
      detail: 'translated:editorPopout.closeConfirmMessage'
    })
    expect(window.webContents.send).toHaveBeenCalledWith('editorPopout:saveAndClose')
  })

  it('keeps one close dialog open until the requested save finishes', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    createOrFocusEditorPopout(request)
    const window = instances[0]
    const closeEvent = { preventDefault: vi.fn() }

    window.emit('close', closeEvent)
    reportEditorPopoutCloseState(window.webContents as never, true)
    await Promise.resolve()
    window.emit('close', closeEvent)
    await Promise.resolve()

    expect(showMessageBoxMock).toHaveBeenCalledOnce()

    completeEditorPopoutSaveAndClose(window.webContents as never, false)
    window.emit('close', closeEvent)
    reportEditorPopoutCloseState(window.webContents as never, true)
    await Promise.resolve()

    expect(showMessageBoxMock).toHaveBeenCalledTimes(2)
  })

  it('closes after the renderer confirms the requested save', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    createOrFocusEditorPopout(request)
    const window = instances[0]

    window.emit('close', { preventDefault: vi.fn() })
    reportEditorPopoutCloseState(window.webContents as never, true)
    await Promise.resolve()
    completeEditorPopoutSaveAndClose(window.webContents as never, true)

    expect(window.close).toHaveBeenCalledOnce()
    expect(window.destroyed).toBe(true)
  })

  it('cleans up without reading destroyed window contents', () => {
    createOrFocusEditorPopout(request)
    const window = instances[0]
    const sender = window.webContents
    Object.defineProperty(window, 'webContents', {
      get: () => {
        throw new TypeError('Object has been destroyed')
      }
    })
    window.destroyed = true

    expect(() => window.emit('closed')).not.toThrow()
    expect(getEditorPopoutRequest(sender as never)).toBeNull()
  })
})
