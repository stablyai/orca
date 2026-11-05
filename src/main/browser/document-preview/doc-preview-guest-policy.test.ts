import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceDocPageGuest, installDocPreviewGuestPolicy } from './doc-preview-guest-policy'
import { buildDocPreviewUrl } from '../../../shared/doc-preview-scheme'
import { mintDocPreviewGrant, revokeAllDocPreviewGrants } from './doc-preview-grant-registry'

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
  describe('tool authorization', () => {
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
  })
})
