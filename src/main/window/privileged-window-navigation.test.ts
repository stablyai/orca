import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternalMock } = vi.hoisted(() => ({ openExternalMock: vi.fn() }))

vi.mock('electron', () => ({ shell: { openExternal: openExternalMock } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

type Handler = (...args: any[]) => unknown

function makeContents() {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    contents: {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
      setWindowOpenHandler: vi.fn((handler: Handler) => handlers.set('window-open', handler))
    }
  }
}

describe('installPrivilegedWindowNavigationPolicy', () => {
  beforeEach(() => openExternalMock.mockReset())

  it('hardens every verified auxiliary webContents', () => {
    const opener = makeContents()
    const child = makeContents()
    installPrivilegedWindowNavigationPolicy(opener.contents as never)

    opener.handlers.get('did-create-window')?.(
      { webContents: child.contents },
      { url: 'about:blank', frameName: 'orca-aux-pane:group-1' }
    )

    expect(child.contents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    expect(child.handlers.get('window-open')?.({ url: 'https://example.com' })).toEqual({
      action: 'deny'
    })
    const preventDefault = vi.fn()
    child.handlers.get('will-navigate')?.({ preventDefault }, 'https://example.com/path')
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/')
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/path')
  })

  it('does not attach auxiliary policy to unverified children', () => {
    const opener = makeContents()
    const child = makeContents()
    installPrivilegedWindowNavigationPolicy(opener.contents as never)

    opener.handlers.get('did-create-window')?.(
      { webContents: child.contents },
      { url: 'https://example.com', frameName: 'orca-aux-pane:group-1' }
    )
    opener.handlers.get('did-create-window')?.(
      { webContents: child.contents },
      { url: 'about:blank', frameName: 'untrusted' }
    )

    expect(child.contents.setWindowOpenHandler).not.toHaveBeenCalled()
  })
})
