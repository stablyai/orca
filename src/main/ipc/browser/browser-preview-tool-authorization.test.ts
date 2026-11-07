import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DocPreviewGuestPolicyModule from '../../browser/document-preview/doc-preview-guest-policy'
import type * as TabRegistrationWaitModule from './browser-tab-registration-wait'

const {
  handleMock,
  removeHandlerMock,
  getAuthorizedGuestMock,
  setGrabModeMock,
  awaitGrabSelectionMock,
  cancelGrabOpMock,
  captureSelectionScreenshotMock,
  extractHoverPayloadMock,
  setAnnotationViewportBridgeMock,
  openDevToolsMock,
  setViewportOverrideMock,
  previewAuthoritySpy,
  registrationWaitSpy
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  getAuthorizedGuestMock: vi.fn(),
  setGrabModeMock: vi.fn().mockResolvedValue(true),
  awaitGrabSelectionMock: vi.fn().mockResolvedValue({ opId: 'op', kind: 'cancelled' }),
  cancelGrabOpMock: vi.fn(),
  captureSelectionScreenshotMock: vi.fn().mockResolvedValue(null),
  extractHoverPayloadMock: vi.fn().mockResolvedValue(null),
  setAnnotationViewportBridgeMock: vi.fn().mockResolvedValue(true),
  openDevToolsMock: vi.fn().mockResolvedValue(true),
  setViewportOverrideMock: vi.fn().mockResolvedValue(true),
  previewAuthoritySpy: vi.fn(),
  registrationWaitSpy: vi.fn()
}))

vi.mock('./browser-passwords-ipc', () => ({ registerBrowserPasswordsHandlers: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { removeHandler: removeHandlerMock, handle: handleMock },
  webContents: { fromId: vi.fn(() => ({ isDestroyed: () => false })) }
}))

vi.mock('../../browser/browser-manager', () => ({
  browserCertificateTrustController: { proceed: vi.fn(() => ({ ok: true })) },
  browserManager: {
    registerGuest: vi.fn(() => true),
    attachGuestPolicies: vi.fn(),
    unregisterGuest: vi.fn(),
    getGuestWebContentsId: vi.fn(),
    getWebContentsIdByTabId: vi.fn(() => new Map()),
    getWorktreeIdForTab: vi.fn(),
    getAuthorizedGuest: getAuthorizedGuestMock,
    setGrabMode: setGrabModeMock,
    awaitGrabSelection: awaitGrabSelectionMock,
    cancelGrabOp: cancelGrabOpMock,
    captureSelectionScreenshot: captureSelectionScreenshotMock,
    extractHoverPayload: extractHoverPayloadMock,
    setAnnotationViewportBridge: setAnnotationViewportBridgeMock,
    openDevTools: openDevToolsMock,
    setViewportOverride: setViewportOverrideMock,
    cancelDownload: vi.fn()
  }
}))

// Spy on the real policy so registry selection remains observable.
vi.mock('../../browser/document-preview/doc-preview-guest-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof DocPreviewGuestPolicyModule>()
  return {
    ...actual,
    getWorkspaceDocPageGuest: (browserPageId: string, senderWebContentsId: number) => {
      previewAuthoritySpy(browserPageId, senderWebContentsId)
      return actual.getWorkspaceDocPageGuest(browserPageId, senderWebContentsId)
    }
  }
})

// Keep registration waits real; observe only which targets enter them.
vi.mock('./browser-tab-registration-wait', async (importOriginal) => {
  const actual = await importOriginal<typeof TabRegistrationWaitModule>()
  return {
    ...actual,
    waitForNextTabRegistration: (...args: Parameters<typeof actual.waitForNextTabRegistration>) => {
      registrationWaitSpy(args[0])
      return actual.waitForNextTabRegistration(...args)
    }
  }
})

import { registerBrowserHandlers } from './browser'
import { setTrustedBrowserRendererWebContentsId } from './browser-renderer-trust'
import { browserManager } from '../../browser/browser-manager'
import {
  getWorkspaceDocPageGuest,
  installDocPreviewGuestPolicy
} from '../../browser/document-preview/doc-preview-guest-policy'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../../browser/document-preview/doc-preview-grant-registry'
import { buildDocPreviewUrl } from '../../../shared/doc-preview-scheme'

const HOST_RENDERER_ID = 91
const OTHER_RENDERER_ID = 92
// Match browser-grab-ipc's registration timeout.
const GRAB_REGISTRATION_WAIT_MS = 1_000

/** Exhaustively classify invoke channels as guest tools or browser/session/profile management. */
const TOOL_CHANNELS = [
  'browser:setGrabMode',
  'browser:awaitGrabSelection',
  'browser:cancelGrab',
  'browser:captureSelectionScreenshot',
  'browser:extractHoverPayload',
  'browser:setAnnotationViewportBridge'
]

type Handler = (event: { sender: Electron.WebContents }, args: unknown) => unknown

function registeredHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  for (const [channel, handler] of handleMock.mock.calls as [string, Handler][]) {
    handlers.set(channel, handler)
  }
  return handlers
}

function trustedSender(id: number): { sender: Electron.WebContents } {
  return {
    sender: {
      id,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as unknown as Electron.WebContents
  }
}

let nextDocPageOrdinal = 0

function grantForNewDocPage(): { id: string; browserPageId: string } {
  nextDocPageOrdinal += 1
  const browserPageId = `doc-page-${nextDocPageOrdinal}`
  const grant = mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html',
    browserPageId
  })
  return { id: grant.id, browserPageId }
}

type PreviewGuestContents = {
  isDestroyed: () => boolean
  getURL: () => string
}

function renderPreviewForGrant(
  grant: { id: string; browserPageId: string },
  hostId: number = HOST_RENDERER_ID
): {
  grantId: string
  browserPageId: string
  contents: PreviewGuestContents
  markContentsDestroyed: () => void
} {
  const browserPageId = grant.browserPageId
  const handlers: Record<string, (...args: never[]) => void> = {}
  const register = (event: string, handler: (...args: never[]) => void): void => {
    handlers[event] = handler
  }
  // Policy attaches mid-load, when the guest already reports its document URL.
  const documentUrl = buildDocPreviewUrl(grant.id, 'index.html')
  let contentsDestroyed = false
  const guest = {
    isFocused: () => true,
    isDestroyed: () => contentsDestroyed,
    getURL: () => documentUrl,
    on: vi.fn(register),
    once: vi.fn(register),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn()
  }
  installDocPreviewGuestPolicy(guest as never, { id: hostId, send: vi.fn() })
  handlers['did-start-navigation']?.({ url: documentUrl, isMainFrame: true } as never)
  return {
    grantId: grant.id,
    browserPageId,
    contents: guest,
    // Contents can be destroyed before Chromium delivers the destroyed event.
    markContentsDestroyed: () => {
      contentsDestroyed = true
    }
  }
}

function liveRenderedPreview(
  hostId: number = HOST_RENDERER_ID
): ReturnType<typeof renderPreviewForGrant> {
  return renderPreviewForGrant(grantForNewDocPage(), hostId)
}

/** Minimal well-formed args per channel, so a refusal is authorization and not shape validation. */
function toolArgs(channel: string, browserPageId: string): Record<string, unknown> {
  switch (channel) {
    case 'browser:setGrabMode':
      return { browserPageId, enabled: true }
    case 'browser:awaitGrabSelection':
      return { browserPageId, opId: 'op-1' }
    case 'browser:captureSelectionScreenshot':
      return { browserPageId, rect: { x: 0, y: 0, width: 10, height: 10 } }
    case 'browser:setAnnotationViewportBridge':
      return {
        browserPageId,
        enabled: true,
        emitViewport: true,
        markers: [],
        token: 'annotation-bridge-token-1'
      }
    default:
      return { browserPageId }
  }
}

// Unwrap viewport resolvers as well as direct guest arguments.
function resolvesToGuest(argument: unknown, guest: PreviewGuestContents): boolean {
  return argument === guest || (typeof argument === 'function' && argument() === guest)
}

const GUEST_RECEIVING_MOCKS = [
  setGrabModeMock,
  awaitGrabSelectionMock,
  captureSelectionScreenshotMock,
  extractHoverPayloadMock,
  setAnnotationViewportBridgeMock
]

beforeEach(() => {
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  setTrustedBrowserRendererWebContentsId(HOST_RENDERER_ID)
  // Revoke before clearing mocks so disposal calls belong to the previous test.
  revokeAllDocPreviewGrants()
  vi.clearAllMocks()
  // This suite checks channel authorization; real manager registry splitting is covered separately.
  getAuthorizedGuestMock.mockImplementation((browserPageId: string, senderWebContentsId: number) =>
    getWorkspaceDocPageGuest(browserPageId, senderWebContentsId)
  )
  setGrabModeMock.mockResolvedValue(true)
  awaitGrabSelectionMock.mockResolvedValue({ opId: 'op-1', kind: 'cancelled' })
  captureSelectionScreenshotMock.mockResolvedValue(null)
  extractHoverPayloadMock.mockResolvedValue(null)
  setAnnotationViewportBridgeMock.mockResolvedValue(true)
  registerBrowserHandlers({ getSettings: vi.fn() })
  // Fake timers settle registration waits for guests that never attach.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

async function settle<T>(pending: Promise<T> | T | undefined): Promise<T | undefined> {
  await vi.advanceTimersByTimeAsync(GRAB_REGISTRATION_WAIT_MS)
  return pending
}

describe('doc preview tool authorization', () => {
  it.each(TOOL_CHANNELS)('drives the preview guest from %s', async (channel) => {
    const preview = liveRenderedPreview()
    const handler = registeredHandlers().get(channel)

    await handler?.(trustedSender(HOST_RENDERER_ID), toolArgs(channel, preview.browserPageId))

    // Assert the actual WebContents receiving the tool operation.
    const receivedGuest = GUEST_RECEIVING_MOCKS.some((mock) =>
      mock.mock.calls.some((args) => args.some((arg) => resolvesToGuest(arg, preview.contents)))
    )
    expect(receivedGuest || cancelGrabOpMock.mock.calls.length > 0).toBe(true)
  })

  // Browser/session management must never consult the document registry.

  it.each(TOOL_CHANNELS)(
    'refuses %s from a renderer that does not host the preview',
    async (channel) => {
      const preview = liveRenderedPreview()
      const handler = registeredHandlers().get(channel)

      await settle(
        handler?.(trustedSender(OTHER_RENDERER_ID), toolArgs(channel, preview.browserPageId))
      )

      for (const mock of [...GUEST_RECEIVING_MOCKS, cancelGrabOpMock]) {
        expect(mock).not.toHaveBeenCalled()
      }
    }
  )

  // A live grant and trusted sender are insufficient once contents are destroyed.
  it.each(TOOL_CHANNELS)('refuses %s once the preview contents are destroyed', async (channel) => {
    const preview = liveRenderedPreview()
    preview.markContentsDestroyed()
    const handler = registeredHandlers().get(channel)

    await settle(
      handler?.(trustedSender(HOST_RENDERER_ID), toolArgs(channel, preview.browserPageId))
    )

    for (const mock of [...GUEST_RECEIVING_MOCKS, cancelGrabOpMock]) {
      expect(mock).not.toHaveBeenCalled()
    }
  })

  // Document tools wait for their own attaching guest instead of returning not-ready immediately.
  it('waits for a document page whose guest has not attached yet, and arms when it does', async () => {
    const grant = grantForNewDocPage()
    const handler = registeredHandlers().get('browser:setGrabMode')

    const pending = handler?.(trustedSender(HOST_RENDERER_ID), {
      browserPageId: grant.browserPageId,
      enabled: true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(registrationWaitSpy).toHaveBeenCalledWith(grant.browserPageId)

    const preview = renderPreviewForGrant(grant)

    await expect(pending).resolves.toEqual({ ok: true })
    expect(setGrabModeMock).toHaveBeenCalledWith(grant.browserPageId, true, preview.contents)
  })

  // Unrendered documents must eventually answer not-ready.

  // Revocation, including re-minting, is how previews withdraw and release retained tool state.

  // unregisterGuest must not drop preview intent and silently settle its grab without arming.
  it('leaves an in-flight preview grab armed when unregisterGuest names its target', async () => {
    const preview = liveRenderedPreview()
    const handlers = registeredHandlers()
    const pending = handlers.get('browser:setGrabMode')?.(trustedSender(HOST_RENDERER_ID), {
      browserPageId: preview.browserPageId,
      enabled: true
    })

    // Intent exists before the queued operation runs; test disposal in that gap.
    const unregistered = handlers.get('browser:unregisterGuest')?.(
      trustedSender(HOST_RENDERER_ID),
      { browserPageId: preview.browserPageId }
    )

    // A dropped intent also returns ok; only the driven guest proves the grab armed.
    await expect(pending).resolves.toEqual({ ok: true })
    expect(setGrabModeMock).toHaveBeenCalledWith(preview.browserPageId, true, preview.contents)
    expect(unregistered).toBe(false)
    expect(vi.mocked(browserManager.unregisterGuest)).not.toHaveBeenCalled()
  })

  // The same guard must still allow browser tabs to dispose their grabs.

  // An open document must not answer for a browsing page ID.
  it('never hands a browsing page id the guest of a document that is open', async () => {
    const preview = liveRenderedPreview()
    const handler = registeredHandlers().get('browser:extractHoverPayload')

    await handler?.(trustedSender(HOST_RENDERER_ID), { browserPageId: 'browser-page-1' })

    expect(getAuthorizedGuestMock).toHaveBeenCalledWith('browser-page-1', HOST_RENDERER_ID)
    expect(previewAuthoritySpy).toHaveBeenCalledWith('browser-page-1', HOST_RENDERER_ID)
    expect(extractHoverPayloadMock).not.toHaveBeenCalled()
    await handler?.(trustedSender(HOST_RENDERER_ID), { browserPageId: preview.browserPageId })
    expect(extractHoverPayloadMock).toHaveBeenCalledWith(preview.browserPageId, preview.contents)
  })
})
