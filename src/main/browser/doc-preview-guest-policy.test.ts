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
  initialUrl = ''
): {
  contents: object
  handlers: GuestHandlers
  hostId: number
  isFocused: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>
  windowOpenHandler: (details: { url: string }) => { action: string }
  /** Model contents teardown before its destroyed event reaches main. */
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

function boundGuest(): { grant: ReturnType<typeof mintGrant>; guest: FakeGuest } {
  const grant = mintGrant()
  const guest = installOnFakeGuest()
  startMainFrameNavigation(guest, buildDocPreviewUrl(grant.id, 'index.html'))
  return { grant, guest }
}

function reportClick(guest: FakeGuest, url: string): void {
  reportDocPreviewLinkClick(guest.contents as never, url)
}

// Distinct pages keep simultaneously live grants from replacing each other in the registry.
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

  describe('the trusted-click route out of the preview', () => {
    it('routes nothing for a scripted location change or window.open, whenever input happened', () => {
      const { guest } = boundGuest()
      const preventDefault = vi.fn()

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
      // No input listeners means there is no timing window for scripted navigation.
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

    it("does not mistake Electron's false webview focus flag for an untrusted click", () => {
      const { guest } = boundGuest()
      guest.isFocused.mockReturnValue(false)

      reportClick(guest, 'https://example.com/docs')

      expect(guest.send).toHaveBeenCalledExactlyOnceWith('docPreview:externalLink', {
        url: 'https://example.com/docs'
      })
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

  it('denies the guest non-proxied WebRTC UDP at attach', () => {
    const guest = installOnFakeGuest()

    expect(guest.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
  })

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

    it('binds a guest that is already showing its document when the policy installs', () => {
      const grant = mintGrant()
      const guest = installOnFakeGuest(HOST_RENDERER_ID, buildDocPreviewUrl(grant.id, 'index.html'))

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBe(guest.contents)
    })

    it('binds a guest whose first navigation only reaches the commit', () => {
      const grant = mintGrant()
      const guest = installOnFakeGuest()

      guest.handlers['did-navigate']?.(
        {} as never,
        buildDocPreviewUrl(grant.id, 'index.html') as never
      )

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBe(guest.contents)
    })

    it('refuses a guest that has not committed a document yet', () => {
      const grant = mintGrant()
      installOnFakeGuest()

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBeNull()
    })

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

    it('refuses a guest whose contents died before the destroy event arrived', () => {
      const { grant, guest } = boundGuest()

      guest.markContentsDestroyed()

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBeNull()
    })

    it('answers nothing for a grant no preview ever rendered', () => {
      const grant = mintGrant()

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBeNull()
    })

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

    it('registers nothing for a guest showing a grant that is already revoked', () => {
      const grant = mintGrant()
      revokeDocPreviewGrant(grant.id)

      const guest = installOnFakeGuest(HOST_RENDERER_ID, buildDocPreviewUrl(grant.id, 'index.html'))

      expect(getWorkspaceDocPageGuest(grant.browserPageId, HOST_RENDERER_ID)).toBeNull()
      const live = mintGrant()
      installOnFakeGuest(HOST_RENDERER_ID, buildDocPreviewUrl(live.id, 'index.html'))
      expect(getWorkspaceDocPageGuest(live.browserPageId, HOST_RENDERER_ID)).not.toBeNull()
      expect(guest.contents).toBeDefined()
    })

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
