import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'

const mocks = vi.hoisted(() => ({
  handleGuestWillDownload: vi.fn(),
  noticeDocPreviewDownloadBlocked: vi.fn()
}))

type WillDownloadListener = (
  event: { preventDefault: () => void },
  item: { id: string },
  webContents: { id: number }
) => void

type FakeSession = {
  listeners: WillDownloadListener[]
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  getUserAgent: () => string
  setUserAgent: ReturnType<typeof vi.fn>
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>
}

const sessionsByPartition = new Map<string, FakeSession>()

function fakeSession(): FakeSession {
  const listeners: WillDownloadListener[] = []
  return {
    listeners,
    on: vi.fn((event: string, listener: WillDownloadListener) => {
      if (event === 'will-download') {
        listeners.push(listener)
      }
    }),
    removeListener: vi.fn((event: string, listener: WillDownloadListener) => {
      if (event !== 'will-download') {
        return
      }
      const index = listeners.indexOf(listener)
      if (index !== -1) {
        listeners.splice(index, 1)
      }
    }),
    getUserAgent: () => 'Mozilla/5.0 Orca',
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn()
  }
}

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      const existing = sessionsByPartition.get(partition)
      if (existing) {
        return existing
      }
      const created = fakeSession()
      sessionsByPartition.set(partition, created)
      return created
    }
  }
}))
vi.mock('./browser-manager', () => ({
  browserManager: {
    handleGuestWillDownload: mocks.handleGuestWillDownload,
    installCertificateRequestGuard: vi.fn(),
    removeCertificateRequestGuard: vi.fn(),
    notifyPermissionDenied: vi.fn()
  }
}))
vi.mock('./doc-preview-download-block-notice', () => ({
  noticeDocPreviewDownloadBlocked: mocks.noticeDocPreviewDownloadBlocked
}))
vi.mock('./browser-media-access', () => ({
  hasSystemMediaAccess: () => false,
  requestSystemMediaAccess: async () => false
}))
vi.mock('./browser-session-ua', () => ({
  cleanElectronUserAgent: (userAgent: string) => userAgent,
  setupClientHintsOverride: vi.fn()
}))
vi.mock('./browser-session-user-agent-mode', () => ({
  setBrowserSessionUserAgentMode: vi.fn()
}))
vi.mock('./browser-webauthn-access', () => ({
  allowsBrowserWebAuthnPermission: () => false,
  clearBrowserWebAuthnAccessHandlers: vi.fn(),
  installBrowserWebAuthnAccessHandlers: vi.fn()
}))

type PartitionPolicyInstaller = (
  profile: BrowserSessionProfile,
  options?: { downloads?: 'route' | 'deny' }
) => void

// Why imported per test rather than at the top: the installer remembers which partitions it has
// already configured in module state, so a shared import would make the second test's install a
// no-op and leave it reading the first test's listener.
async function loadInstaller(): Promise<PartitionPolicyInstaller> {
  const module = await import('./browser-session-partition-policies')
  return module.installBrowserSessionPartitionPolicies
}

function profileFor(partition: string): BrowserSessionProfile {
  return {
    id: partition,
    scope: 'isolated',
    partition,
    label: partition,
    source: null,
    userAgentMode: 'clean'
  }
}

/** Fires the partition's real `will-download` listener and reports what it decided. */
function fireWillDownload(partition: string): { cancelled: boolean } {
  const sess = sessionsByPartition.get(partition)
  if (!sess || sess.listeners.length !== 1) {
    throw new Error(`expected exactly one will-download listener on ${partition}`)
  }
  let cancelled = false
  sess.listeners[0]({ preventDefault: () => (cancelled = true) }, { id: 'item-1' }, { id: 42 })
  return { cancelled }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionsByPartition.clear()
  vi.resetModules()
})

describe('partition download policy', () => {
  // The presence half: without it, a deny assertion passes for a partition that installed no
  // listener at all, and would keep passing if the whole download path were removed.
  it('routes a download on a partition that did not ask for the deny', async () => {
    const install = await loadInstaller()
    install(profileFor('persist:browsing-1'))

    expect(fireWillDownload('persist:browsing-1').cancelled).toBe(false)
    expect(mocks.handleGuestWillDownload).toHaveBeenCalledWith(
      expect.objectContaining({ guestWebContentsId: 42 })
    )
  })

  it('cancels a download on a partition that asked for the deny, routing nothing', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { downloads: 'deny' })

    expect(fireWillDownload('orca-doc-preview').cancelled).toBe(true)
    expect(mocks.handleGuestWillDownload).not.toHaveBeenCalled()
  })

  // Why in the same run as the routing test above: a refusal the reader cannot see is a pressed
  // button that does nothing, and a notice on the routing partition would announce a download that
  // is about to arrive normally.
  it('tells the reader about the refusal, and only on the partition that refused', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { downloads: 'deny' })
    install(profileFor('persist:browsing-1'))

    fireWillDownload('persist:browsing-1')
    expect(mocks.noticeDocPreviewDownloadBlocked).not.toHaveBeenCalled()

    fireWillDownload('orca-doc-preview')
    expect(mocks.noticeDocPreviewDownloadBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 })
    )
  })

  // Why both partitions in one run: the listener is module state shared across sessions, so a deny
  // installed for one partition must not follow the next partition that installs after it.
  it('keeps each partition on its own decision', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { downloads: 'deny' })
    install(profileFor('persist:browsing-1'))

    expect(fireWillDownload('orca-doc-preview').cancelled).toBe(true)
    expect(fireWillDownload('persist:browsing-1').cancelled).toBe(false)
    expect(mocks.handleGuestWillDownload).toHaveBeenCalledTimes(1)
  })
})
