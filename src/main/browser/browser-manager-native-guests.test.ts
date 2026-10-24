import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const mocks = vi.hoisted(() => ({
  contents: new Map<number, WebContents>(),
  natives: new Set<number>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: () => ({ popup: vi.fn() }) },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: (id: number) => mocks.contents.get(id) ?? null }
}))
vi.mock('../window/desktop-renderer-registry', () => ({
  desktopWindowId: (renderer: { id: number }) =>
    mocks.natives.has(renderer.id) ? `native-${renderer.id}` : null
}))
vi.mock('./popup-origin-bar-window', () => ({ openPopupWithOriginBar: vi.fn() }))

import { BrowserManager } from './browser-manager'
import { DestroyedGuestTestContents } from './browser-manager-destroyed-guest-test-fixture'
import { createDownloadItem } from './browser-manager-test-harness'
import { createBrowserClientPageGuestBinding } from './browser-client-page-guest-binding'
import { openBrowserPagePrompt, respondToBrowserPagePrompt } from './browser-page-prompts'
import type { PopupChildWindowOptions } from './popup-origin-bar-window'

class Renderer extends DestroyedGuestTestContents {
  send = vi.fn()
}
const manager = new BrowserManager()

function fixture() {
  const first = new Renderer(5001)
  const second = new Renderer(5002)
  for (const renderer of [first, second]) {
    mocks.contents.set(renderer.id, renderer.asWebContents())
    mocks.natives.add(renderer.id)
  }
  const a = new DestroyedGuestTestContents(101)
  const b = new DestroyedGuestTestContents(102)
  for (const [guest, renderer] of [
    [a, first],
    [b, second]
  ] as const) {
    mocks.contents.set(guest.id, guest.asWebContents())
    manager.attachGuestPolicies(guest.asWebContents())
    expect(
      manager.registerGuest({
        browserPageId: 'shared-page',
        workspaceId: 'workspace',
        worktreeId: 'worktree',
        webContentsId: guest.id,
        rendererWebContentsId: renderer.id
      })
    ).toBe(true)
  }
  return { first, second, a, b }
}

afterEach(() => {
  manager.unregisterAll()
  mocks.contents.clear()
  mocks.natives.clear()
})

describe('native browser page guests', () => {
  it.each([
    { fromPopup: false, fallback: false },
    { fromPopup: true, fallback: false },
    { fromPopup: false, fallback: true },
    { fromPopup: true, fallback: true }
  ])(
    'routes a new tab from A to A after selecting B: $fromPopup/$fallback',
    ({ fromPopup, fallback }) => {
      const { first, second, a } = fixture()
      const opener = fromPopup ? new DestroyedGuestTestContents(106) : a
      if (fromPopup) {
        mocks.contents.set(opener.id, opener.asWebContents())
        manager.attachGuestPolicies(opener.asWebContents(), {
          browserTabId: 'shared-page',
          rootGuestWebContentsId: a.id
        })
      }
      manager.selectNativeRenderer(second.id)
      const url = fallback
        ? 'https://example.test/auth?client_id=orca&redirect_uri=https://example.test&response_type=code'
        : 'https://example.test/new'
      const response = opener.windowOpenHandler?.({
        url,
        frameName: '',
        disposition: 'background-tab',
        features: fallback ? 'width=400' : '',
        referrer: { url: '', policy: 'default' }
      })
      if (fallback) {
        expect(response?.action).toBe('allow')
        if (response?.action !== 'allow' || !response.createWindow) {
          throw new Error('Missing popup create callback')
        }
        const options: PopupChildWindowOptions = {
          webContents: new DestroyedGuestTestContents(107).asWebContents()
        }
        response.createWindow(options)
      } else {
        expect(response).toEqual({ action: 'deny' })
      }
      expect(first.send).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
        browserPageId: 'shared-page',
        url,
        activate: false
      })
      expect(second.send).not.toHaveBeenCalledWith(
        'browser:open-link-in-orca-tab',
        expect.anything()
      )
      if (fromPopup) {
        opener.destroy()
      }
    }
  )

  it('keeps a peer prompt answerable when the other guest of the shared page is destroyed', async () => {
    const { first, second, a, b } = fixture()
    const request = (guest: DestroyedGuestTestContents, settle: (answer: true | null) => void) =>
      openBrowserPagePrompt({
        kind: 'external-app',
        requester: guest.asWebContents(),
        target: manager.resolvePagePromptTarget(guest.asWebContents()),
        details: () => ({ appName: 'Zoom', scheme: 'zoommtg', origin: 'https://example.test' }),
        parseAnswer: (value) => (value === true ? true : undefined),
        settle
      })
    const firstAnswer = vi.fn()
    const secondAnswer = vi.fn()
    expect(request(a, firstAnswer)).toBe('prompting')
    expect(request(b, secondAnswer)).toBe('prompting')
    const pending = second.send.mock.calls.find(
      ([channel]) => channel === 'browser:page-prompt-requested'
    )?.[1]
    if (!pending || typeof pending.requestId !== 'string') {
      throw new Error('No peer prompt')
    }
    a.destroy()
    expect(firstAnswer).toHaveBeenCalledWith(null)
    expect(secondAnswer).not.toHaveBeenCalled()
    expect(second.send).not.toHaveBeenCalledWith('browser:page-prompt-closed', expect.anything())
    expect(
      await respondToBrowserPagePrompt(first.asWebContents(), {
        requestId: pending.requestId,
        answer: true
      })
    ).toBe('rejected')
    expect(
      await respondToBrowserPagePrompt(second.asWebContents(), {
        requestId: pending.requestId,
        answer: true
      })
    ).toBe('answered')
    expect(secondAnswer).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('retains the original policy during a staged replacement and rebinds it on rollback', () => {
    const { first, second, a, b } = fixture()
    const staged = new DestroyedGuestTestContents(103)
    mocks.contents.set(staged.id, staged.asWebContents())
    manager.attachGuestPolicies(staged.asWebContents())
    const binding = createBrowserClientPageGuestBinding(manager)
    const registration = {
      browserPageId: 'shared-page',
      partition: 'persist:old',
      webContentsId: a.id,
      rendererWebContentsId: first.id,
      pageHostGeneration: 1
    }
    const replacement = {
      ...registration,
      partition: 'persist:staged',
      webContentsId: staged.id,
      pageHostGeneration: 2
    }
    const originalListeners = a.listenerCount('before-input-event')
    expect(originalListeners).toBeGreaterThan(0)
    binding.bindReplacement?.({ registration: replacement, browserProfileId: 'staged-profile' })
    expect(a.listenerCount('before-input-event')).toBe(originalListeners)
    expect(manager.getManagedBrowserGuestContext(a.id)?.browserPageId).toBe('shared-page')
    manager.selectNativeRenderer(first.id)
    expect(manager.getGuestWebContentsId('shared-page')).toBe(staged.id)
    binding.bind({ registration, browserProfileId: 'original-profile' })
    binding.release(replacement)
    staged.destroy()
    expect(manager.getGuestWebContentsId('shared-page')).toBe(a.id)
    expect(manager.getSessionProfileIdForTab('shared-page')).toBe('original-profile')
    expect(manager.getRendererContextForGuest(a.id)?.renderer.id).toBe(first.id)
    expect(a.listenerCount('before-input-event')).toBe(originalListeners)
    manager.selectNativeRenderer(second.id)
    expect(manager.getGuestWebContentsId('shared-page')).toBe(b.id)
    expect(manager.getManagedBrowserGuestContext(b.id)?.browserPageId).toBe('shared-page')
  })

  it('retires only the old guest when a retained replacement commits successfully', () => {
    const { first, a, b } = fixture()
    const staged = new DestroyedGuestTestContents(105)
    mocks.contents.set(staged.id, staged.asWebContents())
    manager.attachGuestPolicies(staged.asWebContents())
    manager.registerGuest(
      { browserPageId: 'shared-page', webContentsId: staged.id, rendererWebContentsId: first.id },
      { retainPreviousGuestPolicies: true }
    )
    expect(manager.getManagedBrowserGuestContext(a.id)?.browserPageId).toBe('shared-page')
    a.destroy()
    manager.selectNativeRenderer(first.id)
    expect(manager.getGuestWebContentsId('shared-page')).toBe(staged.id)
    expect(manager.getManagedBrowserGuestContext(staged.id)?.browserPageId).toBe('shared-page')
    expect(staged.listenerCount('before-input-event')).toBeGreaterThan(0)
    expect(manager.getManagedBrowserGuestContext(b.id)?.browserPageId).toBe('shared-page')
    expect(a.listenerCount('before-input-event')).toBe(0)
    staged.destroy()
  })

  it('keeps an inherited popup attributed to its live root after selecting the peer window', () => {
    const { first, second, a, b } = fixture()
    const popup = new DestroyedGuestTestContents(104)
    mocks.contents.set(popup.id, popup.asWebContents())
    manager.attachGuestPolicies(popup.asWebContents(), {
      browserTabId: 'shared-page',
      rootGuestWebContentsId: a.id
    })
    manager.selectNativeRenderer(second.id)
    expect(manager.getGuestWebContentsId('shared-page')).toBe(b.id)
    expect(manager.getOwningTabIdForGuestWebContentsId(popup.id)).toBe('shared-page')
    expect(manager.getRendererContextForGuest(popup.id)).toMatchObject({
      renderer: { id: first.id },
      rootGuestWebContentsId: a.id
    })
    const item = createDownloadItem()
    manager.handleGuestWillDownload({ guestWebContentsId: popup.id, item })
    expect(first.send).toHaveBeenCalledWith(
      'browser:download-requested',
      expect.objectContaining({ browserPageId: 'shared-page' })
    )
    expect(second.send).not.toHaveBeenCalledWith('browser:download-requested', expect.anything())
    a.destroy()
    expect(manager.getOwningTabIdForGuestWebContentsId(popup.id)).toBeNull()
    expect(manager.getRendererContextForGuest(popup.id)).toBeNull()
    popup.destroy()
  })

  it('keeps both guest policies and shortcut owners across selection and either guest closing', () => {
    const { first, second, a, b } = fixture()
    expect(manager.getManagedBrowserGuestContext(a.id)?.browserPageId).toBe('shared-page')
    expect(manager.getManagedBrowserGuestContext(b.id)?.browserPageId).toBe('shared-page')
    expect(manager.getRendererContextForGuest(a.id)?.renderer.id).toBe(first.id)
    expect(manager.getRendererContextForGuest(b.id)?.renderer.id).toBe(second.id)
    const input = {
      type: 'keyDown',
      code: 'KeyL',
      key: 'l',
      control: process.platform !== 'darwin',
      meta: process.platform === 'darwin',
      alt: false,
      shift: false
    }
    a.emit('before-input-event', { preventDefault: vi.fn() }, input)
    expect(first.send).toHaveBeenCalled()
    expect(second.send).not.toHaveBeenCalled()
    manager.selectNativeRenderer(first.id)
    expect(manager.getGuestWebContentsId('shared-page')).toBe(a.id)
    b.destroy()
    expect(manager.getGuestWebContentsId('shared-page')).toBe(a.id)
    expect(manager.getManagedBrowserGuestContext(a.id)?.browserPageId).toBe('shared-page')
    a.destroy()
    expect(manager.getGuestWebContentsId('shared-page')).toBeNull()
  })

  it('keeps the second native guest when the first unregisters and routes downloads to their own renderer', () => {
    const { first, second, a, b } = fixture()
    const item = createDownloadItem()
    const peerItem = createDownloadItem({ getFilename: () => 'peer.csv' })
    manager.handleGuestWillDownload({ guestWebContentsId: b.id, item: peerItem })
    second.send.mockClear()
    manager.handleGuestWillDownload({ guestWebContentsId: a.id, item })
    expect(first.send).toHaveBeenCalledWith(
      'browser:download-requested',
      expect.objectContaining({ browserPageId: 'shared-page' })
    )
    expect(second.send).not.toHaveBeenCalledWith('browser:download-requested', expect.anything())
    manager.selectNativeRenderer(first.id)
    manager.unregisterGuest('shared-page')
    expect(manager.getGuestWebContentsId('shared-page')).toBe(b.id)
    expect(manager.getRendererContextForGuest(b.id)?.renderer.id).toBe(second.id)
    expect(manager.getManagedBrowserGuestContext(b.id)?.browserPageId).toBe('shared-page')
    expect(peerItem.cancel).not.toHaveBeenCalled()
  })
})
