import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readDocPreviewFile: vi.fn(),
  installBrowserSessionPartitionPolicies: vi.fn()
}))

function createFakeSession(): {
  protocol: { isProtocolHandled: () => boolean; handle: ReturnType<typeof vi.fn> }
  webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> }
} {
  return {
    protocol: { isProtocolHandled: () => false, handle: vi.fn() },
    webRequest: { onBeforeRequest: vi.fn() }
  }
}

// Why one session per partition and a distinct default: installing the handler on the default
// session instead of the preview session is otherwise invisible — every read would come back
// from the same object.
const previewSession = createFakeSession()
const defaultSession = createFakeSession()
vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: {
    get defaultSession() {
      return defaultSession
    },
    fromPartition: (partition: string) => {
      if (partition !== 'orca-doc-preview') {
        throw new Error(`unexpected partition ${partition}`)
      }
      return previewSession
    }
  }
}))
vi.mock('./doc-preview-file-reader', () => ({ readDocPreviewFile: mocks.readDocPreviewFile }))
vi.mock('./browser-session-partition-policies', () => ({
  installBrowserSessionPartitionPolicies: mocks.installBrowserSessionPartitionPolicies
}))

import { protocol } from 'electron'
import {
  getDocPreviewSession,
  handleDocPreviewRequest,
  installDocPreviewProtocolHandler,
  isAllowedDocPreviewRequestUrl,
  isDocPreviewSession,
  registerDocPreviewSchemePrivileges
} from './doc-preview-protocol'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants,
  revokeDocPreviewGrant
} from './doc-preview-grant-registry'
import {
  buildDocPreviewUrl,
  DOC_PREVIEW_LOAD_FAILURE_CHANNEL
} from '../../shared/doc-preview-scheme'
import { setDocPreviewFailureSink } from './doc-preview-failure-notice'

function mintGrant(): ReturnType<typeof mintDocPreviewGrant> {
  return mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html',
    browserPageId: 'page-1'
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
  setDocPreviewFailureSink(null)
  mocks.readDocPreviewFile.mockResolvedValue({
    ok: true,
    bytes: Buffer.from('<h1>hi</h1>', 'utf8'),
    contentType: 'text/html; charset=utf-8'
  })
})

describe('handleDocPreviewRequest', () => {
  it('serves an in-grant document with no-store so reload re-reads the workspace', async () => {
    const grant = mintGrant()

    const response = await handleDocPreviewRequest(
      new Request(buildDocPreviewUrl(grant.id, 'index.html'))
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toBe('<h1>hi</h1>')
    expect(mocks.readDocPreviewFile).toHaveBeenCalledWith(grant, 'index.html')
  })

  it('falls back to the granted entry document for a root request', async () => {
    const grant = mintGrant()

    await handleDocPreviewRequest(new Request(`orca-preview://${grant.id}/`))

    expect(mocks.readDocPreviewFile).toHaveBeenCalledWith(grant, 'index.html')
  })

  it('decodes percent-encoded segments before resolving', async () => {
    const grant = mintGrant()

    await handleDocPreviewRequest(new Request(buildDocPreviewUrl(grant.id, 'a b/c#d.html')))

    expect(mocks.readDocPreviewFile).toHaveBeenCalledWith(grant, 'a b/c#d.html')
  })

  it('404s an unknown grant without reading anything', async () => {
    const response = await handleDocPreviewRequest(
      new Request(`orca-preview://${'0'.repeat(32)}/index.html`)
    )

    expect(response.status).toBe(404)
    expect(mocks.readDocPreviewFile).not.toHaveBeenCalled()
  })

  it('404s a revoked grant', async () => {
    const grant = mintGrant()
    revokeDocPreviewGrant(grant.id)

    const response = await handleDocPreviewRequest(
      new Request(buildDocPreviewUrl(grant.id, 'index.html'))
    )

    expect(response.status).toBe(404)
    expect(mocks.readDocPreviewFile).not.toHaveBeenCalled()
  })

  it('404s a malformed grant id', async () => {
    const response = await handleDocPreviewRequest(new Request('orca-preview://not-a-grant/x.html'))

    expect(response.status).toBe(404)
    expect(mocks.readDocPreviewFile).not.toHaveBeenCalled()
  })

  it('propagates the reader status for an unservable asset', async () => {
    const grant = mintGrant()
    mocks.readDocPreviewFile.mockResolvedValue({
      ok: false,
      status: 415,
      reason: 'unsupported-asset',
      message: 'cannot send this file type'
    })

    const response = await handleDocPreviewRequest(
      new Request(buildDocPreviewUrl(grant.id, 'a.woff2'))
    )

    expect(response.status).toBe(415)
    expect(await response.text()).toBe('cannot send this file type')
  })

  // Why: previewed documents are agent-authored, so an outbound request is an exfiltration channel
  // for everything else the grant can read.
  it('serves documents under a self-only content security policy', async () => {
    const grant = mintGrant()

    const response = await handleDocPreviewRequest(
      new Request(buildDocPreviewUrl(grant.id, 'index.html'))
    )

    const policy = response.headers.get('Content-Security-Policy') ?? ''
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("img-src 'self' data:")
    expect(policy).not.toContain('https:')
    // Why assert an absence: `webrtc 'block'` is the obvious directive to reach for here and this
    // Chromium does not implement it — it logs "Unrecognized Content-Security-Policy directive
    // 'webrtc'" and gathers candidates regardless. Adding it back would document a fence that is
    // not there; the guest's IP-handling policy is what actually refuses.
    expect(policy).not.toContain('webrtc')
  })

  // Why: the guest paints a 4xx body as if it were the document, so the shell only learns the
  // reason from this push.
  it('pushes the failure reason for the requested path', async () => {
    const send = vi.fn()
    setDocPreviewFailureSink({ send })
    const grant = mintGrant()
    mocks.readDocPreviewFile.mockResolvedValue({
      ok: false,
      status: 413,
      reason: 'too-large',
      message: 'too large'
    })

    await handleDocPreviewRequest(new Request(buildDocPreviewUrl(grant.id, 'index.html')))

    expect(send).toHaveBeenCalledWith(DOC_PREVIEW_LOAD_FAILURE_CHANNEL, {
      grantId: grant.id,
      relativePath: 'index.html',
      reason: 'too-large'
    })
  })

  it('pushes nothing when the document is served', async () => {
    const send = vi.fn()
    setDocPreviewFailureSink({ send })
    const grant = mintGrant()

    await handleDocPreviewRequest(new Request(buildDocPreviewUrl(grant.id, 'index.html')))

    expect(send).not.toHaveBeenCalled()
  })

  // Why: a grant revoked underneath a live guest 404s like a missing file, and without this push
  // the shell leaves the handler's "Not found" body on screen as if it were the document.
  it('pushes a failure for a revoked grant so the shell can replace the 404 body', async () => {
    const send = vi.fn()
    const grant = mintGrant()
    revokeDocPreviewGrant(grant.id)
    setDocPreviewFailureSink({ send })

    await handleDocPreviewRequest(new Request(buildDocPreviewUrl(grant.id, 'index.html')))

    expect(send).toHaveBeenCalledWith(DOC_PREVIEW_LOAD_FAILURE_CHANNEL, {
      grantId: grant.id,
      relativePath: 'index.html',
      reason: 'unreadable'
    })
  })
})

describe('installDocPreviewProtocolHandler', () => {
  // Why the default session is named here: it is the session every other Electron API reaches for
  // by default, and handling the scheme there would serve preview bytes to ordinary browsing.
  it('handles the scheme on the preview session and nowhere else', () => {
    installDocPreviewProtocolHandler()

    expect(previewSession.protocol.handle).toHaveBeenCalledWith(
      'orca-preview',
      handleDocPreviewRequest
    )
    expect(previewSession.webRequest.onBeforeRequest).toHaveBeenCalled()
    expect(defaultSession.protocol.handle).not.toHaveBeenCalled()
    expect(defaultSession.webRequest.onBeforeRequest).not.toHaveBeenCalled()
  })

  it('cancels every request the preview session should never carry', () => {
    installDocPreviewProtocolHandler()

    const filter = previewSession.webRequest.onBeforeRequest.mock.calls.at(-1)?.[0] as (
      details: { url: string },
      callback: (response: { cancel: boolean }) => void
    ) => void
    const cancelled = (url: string): boolean => {
      let response: { cancel: boolean } | null = null
      filter({ url }, (value) => {
        response = value
      })
      return (response as { cancel: boolean } | null)?.cancel === true
    }

    expect(cancelled('https://cdn.example.com/tracker.js')).toBe(true)
    expect(cancelled(`orca-preview://${'a'.repeat(32)}/index.html`)).toBe(false)
  })

  // Why: preview guests still use the shared installer for certificate, UA, permission and
  // download hooks, with a stricter decision than ordinary browsing partitions.
  it('applies the shared browser partition policies to the preview session', () => {
    installDocPreviewProtocolHandler()

    expect(mocks.installBrowserSessionPartitionPolicies).toHaveBeenCalledWith(
      expect.objectContaining({ partition: 'orca-doc-preview', userAgentMode: 'clean' }),
      expect.anything()
    )
  })

  it('denies downloads and ambient browser permissions on the preview partition', () => {
    installDocPreviewProtocolHandler()

    expect(mocks.installBrowserSessionPartitionPolicies).toHaveBeenCalledWith(expect.anything(), {
      downloads: 'deny',
      permissions: 'deny'
    })
  })
})

describe('registerDocPreviewSchemePrivileges', () => {
  // Why the whole literal and not a subset: every privilege this scheme does not claim is one the
  // document cannot use to escape it. `allowServiceWorkers` would outlive the tab that was granted
  // the read, and `bypassCSP` would undo the self-only policy the handler serves with.
  it('claims exactly the privileges the preview document needs', () => {
    registerDocPreviewSchemePrivileges()

    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: 'orca-preview',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true
        }
      }
    ])
  })
})

describe('isAllowedDocPreviewRequestUrl', () => {
  // Why: the session refuses to carry the request at all, so a CSP bypass in one element type
  // still reaches nothing off-machine.
  it('admits in-document schemes and refuses everything that leaves the machine', () => {
    expect(isAllowedDocPreviewRequestUrl(`orca-preview://${'a'.repeat(32)}/index.html`)).toBe(true)
    expect(isAllowedDocPreviewRequestUrl('devtools://devtools/bundled/inspector.html')).toBe(true)
    expect(isAllowedDocPreviewRequestUrl('data:image/png;base64,AAA')).toBe(true)
    expect(isAllowedDocPreviewRequestUrl('blob:orca-preview://abc/123')).toBe(true)
    expect(isAllowedDocPreviewRequestUrl('https://cdn.example.com/app.css')).toBe(false)
    expect(isAllowedDocPreviewRequestUrl('http://127.0.0.1:9999/exfil')).toBe(false)
    expect(isAllowedDocPreviewRequestUrl('ws://evil.example.com/socket')).toBe(false)
    expect(isAllowedDocPreviewRequestUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('isDocPreviewSession', () => {
  it('claims no session until the preview session has been materialized', () => {
    expect(isDocPreviewSession({} as never)).toBe(false)
  })

  it('matches only the memoized preview session', () => {
    const created = getDocPreviewSession()

    expect(isDocPreviewSession(created)).toBe(true)
    expect(isDocPreviewSession({} as never)).toBe(false)
    expect(getDocPreviewSession()).toBe(created)
  })
})
