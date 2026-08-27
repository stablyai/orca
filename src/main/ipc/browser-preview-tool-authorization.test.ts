import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DocPreviewGuestPolicyModule from '../browser/doc-preview-guest-policy'
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

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { removeHandler: removeHandlerMock, handle: handleMock },
  webContents: { fromId: vi.fn(() => ({ isDestroyed: () => false })) }
}))

vi.mock('../browser/browser-manager', () => ({
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

// Why the real policy module behind a spy: the point of these tests is which half of the page
// registry a channel reads, so a stub of it would prove nothing about what was consulted.
vi.mock('../browser/doc-preview-guest-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof DocPreviewGuestPolicyModule>()
  return {
    ...actual,
    getWorkspaceDocPageGuest: (browserPageId: string, senderWebContentsId: number) => {
      previewAuthoritySpy(browserPageId, senderWebContentsId)
      return actual.getWorkspaceDocPageGuest(browserPageId, senderWebContentsId)
    }
  }
})

// Why spy rather than stub: the wait is real machinery the browser-page path still depends on;
// only whether a preview target enters it is under test.
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
import { browserManager } from '../browser/browser-manager'
import {
  getWorkspaceDocPageGuest,
  installDocPreviewGuestPolicy
} from '../browser/doc-preview-guest-policy'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants,
  revokeDocPreviewGrant
} from '../browser/doc-preview-grant-registry'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'

const HOST_RENDERER_ID = 91
const OTHER_RENDERER_ID = 92
/** Mirrors browser-grab-ipc's own wait, so elapsing it here settles the same parked request. */
const GRAB_REGISTRATION_WAIT_MS = 1_000

/**
 * Every `browser:*` invoke channel, split by whether it acts on a guest the reader is looking at
 * (a tool) or manages browser-page, session and profile state. The split is asserted to be total,
 * so a new channel cannot be added without deciding which side of the preview seam it belongs on.
 */
const TOOL_CHANNELS = [
  'browser:setGrabMode',
  'browser:awaitGrabSelection',
  'browser:cancelGrab',
  'browser:captureSelectionScreenshot',
  'browser:extractHoverPayload',
  'browser:setAnnotationViewportBridge'
]

const BROWSER_PAGE_CHANNELS = [
  'browser:registerGuest',
  'browser:prepareSshWorkspacePartition',
  'browser:repairGuestRegistration',
  'browser:isGuestRegistered',
  'browser:unregisterGuest',
  'browser:respondWebAuthnAccount',
  'browser:proceedCertificate',
  'browser:activeTabChanged',
  'browser:openDevTools',
  'browser:setViewportOverride',
  'browser:publishClientPageMetadata',
  'browser:cancelDownload',
  'browser:session:listProfiles',
  'browser:session:createProfile',
  'browser:session:deleteProfile',
  'browser:session:importCookies',
  'browser:session:resolvePartition',
  'browser:session:clearDefaultCookies',
  'browser:session:importFromBrowserForClientHost',
  'browser:session:clientRouteImportSources',
  'browser:session:detectBrowsers',
  'browser:session:detectBrowsersForClientHost',
  'browser:session:importFromBrowser'
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

/** A preview guest already showing its document, which is the only state a tool can act in. */
function renderPreviewForGrant(
  grant: { id: string; browserPageId: string },
  hostId: number = HOST_RENDERER_ID
): {
  grantId: string
  browserPageId: string
  contents: object
  markContentsDestroyed: () => void
} {
  const browserPageId = grant.browserPageId
  const handlers: Record<string, (...args: never[]) => void> = {}
  const register = (event: string, handler: (...args: never[]) => void): void => {
    handlers[event] = handler
  }
  // Why the guest already reports its URL: the embedder hands a preview over mid-load, so this is
  // the state the policy really installs into.
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
    // Why without the `destroyed` event: Chromium tears the contents down before main runs that
    // listener, so this is the window the authority has to answer for on its own.
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

/** The viewport bridge is handed a resolver rather than the contents, so unwrap one call argument. */
function resolvesToGuest(argument: unknown, guest: object): boolean {
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
  // Why before clearing: revoking the previous test's grants disposes their page state through the
  // mocked manager, and those calls belong to that test, not this one.
  revokeAllDocPreviewGrants()
  vi.clearAllMocks()
  // Why the mocked manager still answers for documents: this file's subject is which channels may
  // reach a document guest, not how the manager splits its registry — that lives in
  // browser-manager-guest-policy-profile.test.ts, against the real manager.
  getAuthorizedGuestMock.mockImplementation((browserPageId: string, senderWebContentsId: number) =>
    getWorkspaceDocPageGuest(browserPageId, senderWebContentsId)
  )
  setGrabModeMock.mockResolvedValue(true)
  awaitGrabSelectionMock.mockResolvedValue({ opId: 'op-1', kind: 'cancelled' })
  captureSelectionScreenshotMock.mockResolvedValue(null)
  extractHoverPayloadMock.mockResolvedValue(null)
  setAnnotationViewportBridgeMock.mockResolvedValue(true)
  registerBrowserHandlers()
  // Why fake timers for the whole file: a tool asking for a page whose guest has not attached parks
  // in the registration wait, and several cases here are exactly the ones that never attach. Real
  // time would spend that wait for each of them.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Settles a tool request, elapsing the registration wait it may be parked in. */
async function settle<T>(pending: Promise<T> | T | undefined): Promise<T | undefined> {
  await vi.advanceTimersByTimeAsync(GRAB_REGISTRATION_WAIT_MS)
  return pending
}

describe('doc preview tool authorization', () => {
  it('classifies every registered browser channel as a tool or a browser-page channel', () => {
    const registered = [...registeredHandlers().keys()].sort()
    const classified = [...TOOL_CHANNELS, ...BROWSER_PAGE_CHANNELS].sort()

    expect(registered).toEqual(classified)
  })

  it.each(TOOL_CHANNELS)('drives the preview guest from %s', async (channel) => {
    const preview = liveRenderedPreview()
    const handler = registeredHandlers().get(channel)

    await handler?.(trustedSender(HOST_RENDERER_ID), toolArgs(channel, preview.browserPageId))

    // Why assert on the guest and not on a return value: the whole point of the seam is which
    // WebContents the tool ends up acting on.
    const receivedGuest = GUEST_RECEIVING_MOCKS.some((mock) =>
      mock.mock.calls.some((args) => args.some((arg) => resolvesToGuest(arg, preview.contents)))
    )
    expect(receivedGuest || cancelGrabOpMock.mock.calls.length > 0).toBe(true)
  })

  // The load-bearing containment claim: page and session management never reads the document half
  // of the registry, so a document page can never be resolved as, or managed like, a browsing one.
  // Nothing here is a per-channel guard — a document guest is simply not in the map these read.
  it.each(BROWSER_PAGE_CHANNELS)('never reads the document registry from %s', async (channel) => {
    const preview = liveRenderedPreview()
    const handler = registeredHandlers().get(channel)

    try {
      await handler?.(trustedSender(HOST_RENDERER_ID), {
        browserPageId: preview.browserPageId,
        profileId: preview.browserPageId,
        environmentId: preview.browserPageId
      })
    } catch {
      // A malformed-for-this-channel payload may throw; the claim is about which registry was read.
    }

    expect(previewAuthoritySpy).not.toHaveBeenCalled()
  })

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

  it.each(TOOL_CHANNELS)('refuses %s for a page no preview rendered', async (channel) => {
    const handler = registeredHandlers().get(channel)

    await settle(
      handler?.(trustedSender(HOST_RENDERER_ID), toolArgs(channel, 'doc-page-unrendered'))
    )

    for (const mock of [...GUEST_RECEIVING_MOCKS, cancelGrabOpMock]) {
      expect(mock).not.toHaveBeenCalled()
    }
  })

  // Why the contents check has to be its own condition: the grant is still live and the sender is
  // still the host, so nothing else in the authority notices that the guest is gone.
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

  // Why this inverts what the split registries used to assert: a document page now registers under
  // its own id, so the wait is reachable and useful — a tool opened while the guest is still
  // attaching parks here instead of answering not-ready at the reader.
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

  // The absence half, with the same presence precondition: a page nothing ever renders still gives
  // the reader an answer rather than hanging on the full timeout.
  it('answers not-ready once the wait for an unrendered page elapses', async () => {
    const handler = registeredHandlers().get('browser:setGrabMode')

    await expect(
      settle(
        handler?.(trustedSender(HOST_RENDERER_ID), {
          browserPageId: 'doc-page-never-rendered',
          enabled: true
        })
      )
    ).resolves.toEqual({ ok: false, reason: 'not-ready' })
  })

  it('still waits for a browser page whose registration may be in flight', async () => {
    const handler = registeredHandlers().get('browser:setGrabMode')

    await settle(
      handler?.(trustedSender(HOST_RENDERER_ID), {
        browserPageId: 'browser-page-1',
        enabled: true
      })
    )

    expect(registrationWaitSpy).toHaveBeenCalledWith('browser-page-1')
  })

  // Why the grant and not the guest: a preview withdraws by revoking, which is also what a
  // re-mint does, and nothing else tells main that this tool target will never be used again.
  it('disposes the grab state a preview target accumulated when its grant is revoked', async () => {
    const preview = liveRenderedPreview()
    const handler = registeredHandlers().get('browser:setGrabMode')
    await handler?.(trustedSender(HOST_RENDERER_ID), {
      browserPageId: preview.browserPageId,
      enabled: true
    })
    cancelGrabOpMock.mockClear()

    revokeDocPreviewGrant(preview.grantId)

    expect(cancelGrabOpMock).toHaveBeenCalledWith(preview.browserPageId, 'evicted')
  })

  // Why both halves of this door: the manager refuses a preview id on its own, but the grab
  // disposal beside it takes a renderer-supplied id, and the intent it drops is compared by
  // identity — dropping it makes the grab settle ok without ever arming the guest.
  it('leaves an in-flight preview grab armed when unregisterGuest names its target', async () => {
    const preview = liveRenderedPreview()
    const handlers = registeredHandlers()
    const pending = handlers.get('browser:setGrabMode')?.(trustedSender(HOST_RENDERER_ID), {
      browserPageId: preview.browserPageId,
      enabled: true
    })

    // Why synchronously here: the intent is recorded before the queued operation runs, so this is
    // the exact window in which a disposal at this door would be invisible to the caller.
    const unregistered = handlers.get('browser:unregisterGuest')?.(
      trustedSender(HOST_RENDERER_ID),
      { browserPageId: preview.browserPageId }
    )

    // Why the guest and not the result: a dropped intent settles as ok either way, so only the
    // guest actually being driven separates an armed grab from a silent no-op.
    await expect(pending).resolves.toEqual({ ok: true })
    expect(setGrabModeMock).toHaveBeenCalledWith(preview.browserPageId, true, preview.contents)
    expect(unregistered).toBe(false)
    expect(vi.mocked(browserManager.unregisterGuest)).not.toHaveBeenCalled()
  })

  // The converse, so the guard above cannot be widened into a door that stops closing tabs.
  it('still disposes a browser page grab through the same door', async () => {
    getAuthorizedGuestMock.mockReturnValue({ isDestroyed: () => false })
    const handlers = registeredHandlers()
    const pending = handlers.get('browser:setGrabMode')?.(trustedSender(HOST_RENDERER_ID), {
      browserPageId: 'browser-page-1',
      enabled: true
    })

    const unregistered = handlers.get('browser:unregisterGuest')?.(
      trustedSender(HOST_RENDERER_ID),
      { browserPageId: 'browser-page-1' }
    )

    expect(unregistered).toBe(true)
    await expect(pending).resolves.toEqual({ ok: true })
    expect(setGrabModeMock).not.toHaveBeenCalled()
    expect(vi.mocked(browserManager.unregisterGuest)).toHaveBeenCalledWith('browser-page-1')
  })

  // Why with a live preview standing beside it: the halves are looked up in one door now, so the
  // thing to prove is that a browsing id is not answered by whatever document happens to be open.
  it('never hands a browsing page id the guest of a document that is open', async () => {
    const preview = liveRenderedPreview()
    const handler = registeredHandlers().get('browser:extractHoverPayload')

    await handler?.(trustedSender(HOST_RENDERER_ID), { browserPageId: 'browser-page-1' })

    expect(getAuthorizedGuestMock).toHaveBeenCalledWith('browser-page-1', HOST_RENDERER_ID)
    expect(previewAuthoritySpy).toHaveBeenCalledWith('browser-page-1', HOST_RENDERER_ID)
    expect(extractHoverPayloadMock).not.toHaveBeenCalled()
    // The presence half: the same channel does reach that guest under the page it really renders.
    await handler?.(trustedSender(HOST_RENDERER_ID), { browserPageId: preview.browserPageId })
    expect(extractHoverPayloadMock).toHaveBeenCalledWith(preview.browserPageId, preview.contents)
  })
})
