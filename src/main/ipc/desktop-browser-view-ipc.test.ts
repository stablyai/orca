import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBrowserViewPageService } from './desktop-browser-view-ipc'

const { handlers, trusted } = vi.hoisted(() => ({
  handlers: new Map<string, (event: Electron.IpcMainInvokeEvent, args: unknown) => unknown>(),
  trusted: vi.fn(() => true)
}))
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (
      channel: string,
      callback: (event: Electron.IpcMainInvokeEvent, args: unknown) => unknown
    ) => handlers.set(channel, callback)
  }
}))
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: trusted }))

import { registerDesktopBrowserViewHandlers } from './desktop-browser-view-ipc'

function eventForMainFrame(mainFrame = true): Electron.IpcMainInvokeEvent {
  const frame = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only reads sender and frame identity, with trust checked by the test mock.
  return {
    sender: { mainFrame: frame },
    senderFrame: mainFrame ? frame : {}
  } as Electron.IpcMainInvokeEvent
}

describe('desktop browser view IPC admission', () => {
  const service: DesktopBrowserViewPageService = {
    create: vi.fn(),
    updateLayout: vi.fn(),
    command: vi.fn(),
    input: vi.fn(),
    captureViewport: vi.fn(),
    close: vi.fn()
  }
  const createArgs = {
    browserPageId: 'page',
    workspaceId: 'workspace',
    worktreeId: 'folder',
    sessionProfileId: null,
    url: 'https://example.test'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    trusted.mockReturnValue(true)
    registerDesktopBrowserViewHandlers(service)
  })

  it('requires the trusted main frame for every native operation', () => {
    for (const handler of handlers.values()) {
      expect(() => handler(eventForMainFrame(false), {})).toThrow('trusted main renderer frame')
    }
    trusted.mockReturnValue(false)
    for (const handler of handlers.values()) {
      expect(() => handler(eventForMainFrame(), {})).toThrow('trusted main renderer frame')
    }
    expect(service.create).not.toHaveBeenCalled()
    expect(service.command).not.toHaveBeenCalled()
    expect(service.captureViewport).not.toHaveBeenCalled()
    expect(service.updateLayout).not.toHaveBeenCalled()
    expect(service.close).not.toHaveBeenCalled()
  })

  it('normalizes initial navigation and rejects renderer-selected native capabilities', () => {
    const handler = handlers.get('browser:desktop-view:create')!
    const event = eventForMainFrame()
    handler(event, createArgs)
    expect(service.create).toHaveBeenCalledWith(event.sender, {
      ...createArgs,
      url: 'https://example.test/'
    })
    for (const forbidden of [
      { preload: 'file:///privileged.js' },
      { partition: 'persist:foreign' },
      { webContentsId: 99 }
    ]) {
      expect(() => handler(event, { ...createArgs, ...forbidden })).toThrow()
    }
    expect(() => handler(event, { ...createArgs, url: 'javascript:alert(1)' })).toThrow()
    expect(service.create).toHaveBeenCalledTimes(1)
  })

  it('captures only the requested page generation without renderer-selected native ids', () => {
    const handler = handlers.get('browser:desktop-view:capture-viewport')!
    const event = eventForMainFrame()
    const identity = { browserPageId: 'page', generation: 'generation' }
    handler(event, identity)
    expect(service.captureViewport).toHaveBeenCalledWith(event.sender, identity)
    expect(() => handler(event, { ...identity, webContentsId: 8 })).toThrow()
    expect(() => handler(event, { browserPageId: 'page' })).toThrow()
    expect(service.captureViewport).toHaveBeenCalledOnce()
  })

  it('accepts only finite supported commands and integer clipped-layout inputs', () => {
    const event = eventForMainFrame()
    const command = handlers.get('browser:desktop-view:command')!
    const identity = { browserPageId: 'page', generation: 'generation' }
    command(event, { ...identity, command: { kind: 'snapshot' } })
    expect(service.command).toHaveBeenCalledOnce()
    expect(() =>
      command(event, { ...identity, command: { kind: 'executeJavaScript', code: '1' } })
    ).toThrow()
    expect(() =>
      command(event, { ...identity, command: { kind: 'zoom', level: Infinity } })
    ).toThrow()
    const layout = handlers.get('browser:desktop-view:layout')!
    expect(() =>
      layout(event, {
        ...identity,
        bounds: { x: 0, y: 0, width: 1.5, height: 40 },
        visible: true,
        inputLocked: false
      })
    ).toThrow()
    expect(service.updateLayout).not.toHaveBeenCalled()
  })
})
