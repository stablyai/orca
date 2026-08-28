import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  isTrustedBrowserRenderer: vi.fn(),
  reportDocPreviewLinkClick: vi.fn(),
  getGuestWebContentsId: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    },
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.listeners.set(channel, listener)
    }
  }
}))
vi.mock('./browser-renderer-trust', () => ({
  isTrustedBrowserRenderer: mocks.isTrustedBrowserRenderer
}))
vi.mock('../browser/doc-preview-guest-policy', () => ({
  reportDocPreviewLinkClick: mocks.reportDocPreviewLinkClick
}))
vi.mock('../browser/browser-manager', () => ({
  browserManager: { getGuestWebContentsId: mocks.getGuestWebContentsId }
}))

import {
  registerDocPreviewGrantHandlers,
  type DocPreviewGrantRequest
} from './doc-preview-grant-ipc'
import {
  getDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../browser/doc-preview-grant-registry'
import {
  DOC_PREVIEW_AUTHORIZE_DIRECTORY_CHANNEL,
  DOC_PREVIEW_LINK_CLICK_CHANNEL,
  DOC_PREVIEW_MINT_GRANT_CHANNEL,
  DOC_PREVIEW_REVOKE_GRANT_CHANNEL,
  parseDocPreviewUrl
} from '../../shared/doc-preview-scheme'

const REQUEST: DocPreviewGrantRequest = {
  owner: { kind: 'ssh', connectionId: 'ssh-1' },
  requestBase: '/home/alice/docs',
  root: '/home/alice/docs',
  entryRelativePath: 'index.html',
  browserPageId: 'doc-page-1'
}

const sender = { id: 7 }

function mint(request: DocPreviewGrantRequest = REQUEST): { grantId: string; url: string } {
  const handler = mocks.handlers.get(DOC_PREVIEW_MINT_GRANT_CHANNEL)
  if (!handler) {
    throw new Error('mint handler not registered')
  }
  return handler({ sender }, request) as { grantId: string; url: string }
}

function revoke(grantId: string): boolean {
  const handler = mocks.handlers.get(DOC_PREVIEW_REVOKE_GRANT_CHANNEL)
  if (!handler) {
    throw new Error('revoke handler not registered')
  }
  return handler({ sender }, grantId) as boolean
}

function authorize(grantId: unknown, relativePath: unknown): boolean {
  const handler = mocks.handlers.get(DOC_PREVIEW_AUTHORIZE_DIRECTORY_CHANNEL)
  if (!handler) {
    throw new Error('authorize handler not registered')
  }
  return handler({ sender }, grantId, relativePath) as boolean
}

function reportLinkClick(url: unknown): void {
  const listener = mocks.listeners.get(DOC_PREVIEW_LINK_CLICK_CHANNEL)
  if (!listener) {
    throw new Error('link click listener not registered')
  }
  listener({ sender }, url)
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.listeners.clear()
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
  mocks.isTrustedBrowserRenderer.mockReturnValue(true)
  mocks.getGuestWebContentsId.mockReturnValue(null)
  registerDocPreviewGrantHandlers()
})

describe('document preview grant handlers', () => {
  it('mints a grant addressable by the URL it returns', () => {
    const result = mint()

    expect(parseDocPreviewUrl(result.url)).toEqual({
      grantId: result.grantId,
      relativePath: 'index.html'
    })
    expect(getDocPreviewGrant(result.grantId)?.root).toBe('/home/alice/docs')
    expect(mocks.isTrustedBrowserRenderer).toHaveBeenCalledWith(sender)
  })

  it('revokes a grant it minted', () => {
    const result = mint()

    expect(revoke(result.grantId)).toBe(true)
    expect(getDocPreviewGrant(result.grantId)).toBeNull()
  })

  it('rejects a request that names no root, entry document or page', () => {
    expect(() => mint({ ...REQUEST, root: '  ' })).toThrow(/Invalid/)
    expect(() => mint({ ...REQUEST, entryRelativePath: '' })).toThrow(/Invalid/)
    expect(() => mint({ ...REQUEST, browserPageId: ' ' })).toThrow(/Invalid/)
  })

  // Why this is refused here and not left to registration: this is where a page becomes a document
  // page, and the two halves of the page registry have to stay disjoint. A page already hosting a
  // browsing guest would otherwise resolve in both, and the tool door prefers the document one.
  it('refuses to make a page that already hosts a browsing guest into a document page', () => {
    mocks.getGuestWebContentsId.mockReturnValue(42)

    expect(() => mint()).toThrow(/browsing page/)
    expect(mocks.getGuestWebContentsId).toHaveBeenCalledWith('doc-page-1')
  })

  // Why: this channel hands out filesystem-read authority, so an untrusted sender must leave with
  // nothing rather than with a grant id the scheme handler would honor.
  it('mints nothing for a sender that is not the trusted renderer', () => {
    mocks.isTrustedBrowserRenderer.mockReturnValue(false)

    expect(() => mint()).toThrow(/Untrusted/)
  })

  it('refuses to revoke on behalf of a sender that is not the trusted renderer', () => {
    const result = mint()
    mocks.isTrustedBrowserRenderer.mockReturnValue(false)

    expect(revoke(result.grantId)).toBe(false)
    expect(getDocPreviewGrant(result.grantId)).not.toBeNull()
  })

  it('lets only the trusted renderer authorize a valid requested directory', () => {
    const result = mint({
      ...REQUEST,
      requestBase: '/home/alice',
      root: '/home/alice/docs',
      entryRelativePath: 'docs/index.html'
    })

    expect(authorize(result.grantId, 'assets/app.js')).toBe(true)
    expect(getDocPreviewGrant(result.grantId)?.authorizedRoots).toEqual(['/home/alice/assets'])

    mocks.isTrustedBrowserRenderer.mockReturnValue(false)
    expect(authorize(result.grantId, 'secrets/token.txt')).toBe(false)
    expect(getDocPreviewGrant(result.grantId)?.authorizedRoots).toEqual(['/home/alice/assets'])
  })

  it('refuses malformed directory authorization arguments', () => {
    const result = mint()

    expect(authorize(result.grantId, '../secret.txt')).toBe(false)
    expect(authorize(result.grantId, null)).toBe(false)
    expect(authorize(null, 'assets/app.js')).toBe(false)
    expect(authorize('0'.repeat(32), 'assets/app.js')).toBe(false)
  })

  // Why this channel skips the trusted-renderer check: its sender is a preview guest rendering a
  // workspace document, which is the untrusted side by construction. The guest policy holds the
  // gate, so all this listener owes is the sender and a string.
  it('hands a reported link click to the guest policy with the sender that reported it', () => {
    reportLinkClick('https://example.com/docs')

    expect(mocks.reportDocPreviewLinkClick).toHaveBeenCalledExactlyOnceWith(
      sender,
      'https://example.com/docs'
    )
    expect(mocks.isTrustedBrowserRenderer).not.toHaveBeenCalled()
  })

  it('ignores a reported click that is not a string at all', () => {
    reportLinkClick({ url: 'https://example.com/docs' })
    reportLinkClick(undefined)

    expect(mocks.reportDocPreviewLinkClick).not.toHaveBeenCalled()
  })
})
