import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_BROWSER_BRIDGE_METHODS,
  type DesktopBrowserBridgeRequest
} from '../../../shared/desktop-browser-bridge-protocol'
import {
  boundRemoteCliBrowserWork,
  captureRemoteCliBrowserRevocation,
  resolveRemoteCliBrowserScopeSelector,
  runInRemoteCliBrowserScope
} from '../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import {
  executeDesktopBrowserBridgeRequest,
  isHostReachableDocument,
  type DesktopBrowserBridgeAuditEntry,
  type DesktopBrowserBridgeExecutorDeps
} from './desktop-browser-bridge-executor'

const HOST_WORKSPACE = 'repo-host::/srv/app'
const LOCAL_WORKSPACE = 'repo-local::/Users/me/app'
// The renderer knows page records before their webviews mount.
const PAGE_OWNERS: Record<string, string> = {
  'host-page': HOST_WORKSPACE,
  'unmounted-host-page': HOST_WORKSPACE,
  'local-page': LOCAL_WORKSPACE
}
const MOUNTED_PAGE_OWNERS: Record<string, string> = {
  'host-page': HOST_WORKSPACE,
  'local-page': LOCAL_WORKSPACE
}

async function rendererScope(scope: {
  workspaceId: string | null
  page: string | null
}): Promise<string | null> {
  const pageWorkspace = scope.page ? (PAGE_OWNERS[scope.page] ?? null) : null
  if (scope.page && !pageWorkspace) {
    return null
  }
  if (scope.workspaceId && pageWorkspace && scope.workspaceId !== pageWorkspace) {
    return null
  }
  const workspaceId = pageWorkspace ?? scope.workspaceId
  return workspaceId === HOST_WORKSPACE ? workspaceId : null
}

function request(overrides: Partial<DesktopBrowserBridgeRequest>): DesktopBrowserBridgeRequest {
  return {
    type: 'request',
    requestId: 'r1',
    method: 'browser.snapshot',
    params: {},
    ...overrides
  }
}

function deps(overrides: Partial<DesktopBrowserBridgeExecutorDeps> = {}) {
  const audit: DesktopBrowserBridgeAuditEntry[] = []
  const driven: string[] = []
  const dispatched: { method: string; params: Record<string, unknown>; scopeProbe: unknown }[] = []
  const value: DesktopBrowserBridgeExecutorDeps = {
    environmentId: 'env-host',
    hostLabel: 'sandbox',
    resolveWorkspace: rendererScope,
    worktreeIdForPage: (page) => MOUNTED_PAGE_OWNERS[page] ?? null,
    markWorkspaceDriven: (workspaceId) => driven.push(workspaceId),
    isHostBrowsingRouted: () => true,
    isGuestRoutedThroughHost: () => true,
    dispatch: async (method, params) => {
      const scopeProbe = await resolveRemoteCliBrowserScopeSelector(`id:${LOCAL_WORKSPACE}`)?.catch(
        (error: Error) => error.message
      )
      dispatched.push({ method, params, scopeProbe })
      return { id: 'x', ok: true, result: { done: true }, _meta: { runtimeId: 'desktop' } }
    },
    audit: (entry) => audit.push(entry),
    ...overrides
  }
  return { value, audit, dispatched, driven }
}

describe('executeDesktopBrowserBridgeRequest', () => {
  it('runs an allowlisted command pinned to the host workspace and audits it', async () => {
    const { value, audit, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({
        method: 'browser.goto',
        workspaceId: HOST_WORKSPACE,
        params: { url: 'https://example.com/path?token=secret', worktree: `id:${HOST_WORKSPACE}` }
      }),
      value
    )

    expect(outcome).toEqual({ ok: true, result: { done: true } })
    expect(dispatched).toEqual([
      {
        method: 'browser.goto',
        params: { url: 'https://example.com/path?token=secret', worktree: `id:${HOST_WORKSPACE}` },
        scopeProbe: 'An SSH host can only reach browser tabs in its own workspaces.'
      }
    ])
    // Query strings can contain credentials; audit only the origin.
    expect(audit).toEqual([
      expect.objectContaining({
        method: 'browser.goto',
        workspaceId: HOST_WORKSPACE,
        urlOrigin: 'https://example.com',
        outcome: 'ok'
      })
    ])
    expect(JSON.stringify(audit)).not.toContain('secret')
  })

  it('refuses a workspace this desktop does not show as the host’s own', async () => {
    const { value, audit, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: LOCAL_WORKSPACE, params: { worktree: `id:${LOCAL_WORKSPACE}` } }),
      value
    )

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_out_of_scope' }
    })
    expect(dispatched).toEqual([])
    expect(audit[0]).toMatchObject({ outcome: 'refused' })
  })

  it('refuses a page in another workspace as if it did not exist', async () => {
    const { value, dispatched } = deps()

    const pageOnly = await executeDesktopBrowserBridgeRequest(
      request({ params: { page: 'local-page' } }),
      value
    )
    const crossWorkspace = await executeDesktopBrowserBridgeRequest(
      request({
        workspaceId: HOST_WORKSPACE,
        params: { page: 'local-page', worktree: `id:${HOST_WORKSPACE}` }
      }),
      value
    )

    expect(pageOnly).toMatchObject({ ok: false, error: { code: 'browser_tab_not_found' } })
    expect(crossWorkspace).toMatchObject({ ok: false, error: { code: 'browser_tab_not_found' } })
    expect(dispatched).toEqual([])
  })

  it('scopes a page-only command to the page’s workspace once that is authorized', async () => {
    const { value, dispatched } = deps()

    await executeDesktopBrowserBridgeRequest(
      request({ method: 'browser.click', params: { page: 'host-page', element: 'e1' } }),
      value
    )

    expect(dispatched[0]?.params).toEqual({
      page: 'host-page',
      element: 'e1',
      worktree: `id:${HOST_WORKSPACE}`
    })
  })

  it('refuses a command that names no workspace rather than widening to every tab', async () => {
    const { value, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(request({ params: {} }), value)

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_out_of_scope' }
    })
    expect(dispatched).toEqual([])
  })

  it('refuses a worktree param that disagrees with the resolved workspace', async () => {
    const { value, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { worktree: `id:${LOCAL_WORKSPACE}` } }),
      value
    )

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_out_of_scope' }
    })
    expect(dispatched).toEqual([])
  })

  it.each([
    'browser.cookie.get',
    'browser.cookie.set',
    'browser.upload',
    'browser.download',
    'browser.pdf',
    'browser.exec',
    'browser.clipboardRead',
    'browser.clipboardWrite',
    'browser.profileImportFromBrowser',
    'browser.tabSetProfile',
    'browser.certificate.proceed',
    'browser.storage.local.get',
    'browser.setCredentials',
    'browser.clientHost.attach',
    'terminal.send',
    'files.read'
  ])('refuses %s even when a host sends it', async (method) => {
    expect(DESKTOP_BROWSER_BRIDGE_METHODS.has(method)).toBe(false)
    const { value, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({
        method,
        workspaceId: HOST_WORKSPACE,
        params: { worktree: `id:${HOST_WORKSPACE}` }
      }),
      value
    )

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_not_forwarded' }
    })
    expect(dispatched).toEqual([])
  })

  it('creates a tab only with the host’s url and workspace, never its profile, group, page id or focus', async () => {
    const { value, dispatched } = deps()

    await executeDesktopBrowserBridgeRequest(
      request({
        method: 'browser.tabCreate',
        workspaceId: HOST_WORKSPACE,
        params: {
          url: 'https://example.com',
          worktree: `id:${HOST_WORKSPACE}`,
          page: 'local-page',
          profileId: 'work-profile',
          targetGroupId: 'local-group',
          activate: true,
          navigation: 'caller',
          placement: { kind: 'client', browserHostClientId: 'x' }
        }
      }),
      value
    )

    expect(dispatched[0]?.params).toEqual({
      url: 'https://example.com',
      worktree: `id:${HOST_WORKSPACE}`
    })
  })

  it('returns the desktop’s own error unchanged and audits the failure', async () => {
    const { value, audit } = deps({
      dispatch: async () => ({
        id: 'x',
        ok: false,
        error: { code: 'browser_no_tab', message: 'No browser tab open in this worktree' },
        _meta: { runtimeId: 'desktop' }
      })
    })

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { worktree: `id:${HOST_WORKSPACE}` } }),
      value
    )

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'browser_no_tab', message: 'No browser tab open in this worktree' }
    })
    expect(audit[0]).toMatchObject({ outcome: 'failed', code: 'browser_no_tab' })
  })

  it('treats a renderer that cannot answer as a refusal', async () => {
    const resolveWorkspace = vi.fn(async () => null)
    const { value, dispatched } = deps({ resolveWorkspace })

    await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { worktree: `id:${HOST_WORKSPACE}` } }),
      value
    )

    expect(resolveWorkspace).toHaveBeenCalledWith({ workspaceId: HOST_WORKSPACE, page: null })
    expect(dispatched).toEqual([])
  })

  it('drives a host page the renderer knows before its webview has mounted', async () => {
    const { value, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({
        method: 'browser.goto',
        params: { page: 'unmounted-host-page', url: 'https://a.test' }
      }),
      value
    )

    expect(outcome).toEqual({ ok: true, result: { done: true } })
    expect(dispatched[0]?.params).toEqual({
      page: 'unmounted-host-page',
      url: 'https://a.test',
      worktree: `id:${HOST_WORKSPACE}`
    })
  })

  it('refuses a page whose mounted webview registered under another workspace', async () => {
    const { value, dispatched } = deps({
      worktreeIdForPage: (page) => (page === 'host-page' ? LOCAL_WORKSPACE : null)
    })

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ params: { page: 'host-page' } }),
      value
    )

    expect(outcome).toMatchObject({ ok: false, error: { code: 'browser_tab_not_found' } })
    expect(dispatched).toEqual([])
  })

  it('marks the workspace it drives so its pages lose programmatic clipboard reads', async () => {
    const { value, driven } = deps()

    await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { worktree: `id:${HOST_WORKSPACE}` } }),
      value
    )

    expect(driven).toEqual([HOST_WORKSPACE])
  })

  it.each([
    'file:///etc/passwd',
    '/etc/passwd',
    'localhost:3000',
    'javascript:alert(1)',
    'chrome://settings',
    'data:text/html,hi'
  ])('refuses to navigate or open %s', async (url) => {
    const { value, dispatched } = deps()

    for (const method of ['browser.goto', 'browser.tabCreate']) {
      const outcome = await executeDesktopBrowserBridgeRequest(
        request({
          method,
          workspaceId: HOST_WORKSPACE,
          params: { url, worktree: `id:${HOST_WORKSPACE}` }
        }),
        value
      )
      expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    expect(dispatched).toEqual([])
  })

  it('opens http(s) URLs and a blank tab', async () => {
    const { value, dispatched } = deps()

    for (const params of [{ url: 'http://localhost:3000/a' }, { url: 'https://a.test' }, {}]) {
      await executeDesktopBrowserBridgeRequest(
        request({
          method: 'browser.tabCreate',
          workspaceId: HOST_WORKSPACE,
          params: { ...params, worktree: `id:${HOST_WORKSPACE}` }
        }),
        value
      )
    }

    expect(dispatched).toHaveLength(3)
  })

  it.each([
    'Control+v',
    'Meta+V',
    'cmd + v',
    'Win+v',
    'Super+v',
    'Shift+Insert',
    'Shift+Ins',
    'Control+Shift+V',
    'Alt+Meta+v'
  ])('refuses the paste chord %s', async (key) => {
    const { value, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({
        method: 'browser.keypress',
        workspaceId: HOST_WORKSPACE,
        params: { key, worktree: `id:${HOST_WORKSPACE}` }
      }),
      value
    )

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_not_forwarded' }
    })
    expect(dispatched).toEqual([])
  })

  it('lets ordinary keys through', async () => {
    const { value, dispatched } = deps()

    for (const key of ['Enter', 'v', 'Control+a', 'Shift+Tab']) {
      await executeDesktopBrowserBridgeRequest(
        request({
          method: 'browser.keypress',
          workspaceId: HOST_WORKSPACE,
          params: { key, worktree: `id:${HOST_WORKSPACE}` }
        }),
        value
      )
    }

    expect(dispatched).toHaveLength(4)
  })

  it('never runs a command whose bridge was revoked while its scope was being checked', async () => {
    const revoked = new AbortController()
    const { value, dispatched } = deps({
      resolveWorkspace: async (scope) => {
        revoked.abort()
        return rendererScope(scope)
      }
    })

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { worktree: `id:${HOST_WORKSPACE}` } }),
      value,
      revoked.signal
    )

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_unavailable' }
    })
    expect(dispatched).toEqual([])
  })

  it('passes option-like text from a host through to the browser', async () => {
    const { value, dispatched } = deps()

    for (const [method, extra] of [
      ['browser.eval', { expression: '-1 + 2' }],
      ['browser.fill', { element: 'e1', value: '-5' }],
      ['browser.type', { input: '--help' }]
    ] as const) {
      await executeDesktopBrowserBridgeRequest(
        request({
          method,
          workspaceId: HOST_WORKSPACE,
          params: { ...extra, worktree: `id:${HOST_WORKSPACE}` }
        }),
        value
      )
    }

    expect(dispatched).toHaveLength(3)
  })

  it("refuses every command while the host's tabs browse from this desktop's own network", async () => {
    const { value, dispatched, driven } = deps({ isHostBrowsingRouted: () => false })

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({
        method: 'browser.goto',
        workspaceId: HOST_WORKSPACE,
        params: { url: 'http://127.0.0.1:8080', worktree: `id:${HOST_WORKSPACE}` }
      }),
      value
    )

    expect(outcome).toMatchObject({ ok: false, error: { code: 'desktop_browser_bridge_unrouted' } })
    expect(dispatched).toEqual([])
    expect(driven).toEqual([])
  })
})

describe('resolveRemoteCliBrowserScopeSelector', () => {
  it('does nothing outside a bridged command', () => {
    expect(resolveRemoteCliBrowserScopeSelector(`id:${LOCAL_WORKSPACE}`)).toBeNull()
  })
})

describe('captureRemoteCliBrowserRevocation', () => {
  it('stops a command queued under a bridge that detached before it ran', async () => {
    const revoked = new AbortController()
    const assertNotRevoked = await runInRemoteCliBrowserScope(
      HOST_WORKSPACE,
      async () => captureRemoteCliBrowserRevocation(),
      revoked.signal
    )

    expect(() => assertNotRevoked()).not.toThrow()
    revoked.abort()
    expect(() => assertNotRevoked()).toThrow('stopped sharing its browser')
  })

  it('never blocks a command that did not come from a host', () => {
    const assertNotRevoked = captureRemoteCliBrowserRevocation()
    expect(() => assertNotRevoked()).not.toThrow()
  })
})

describe('boundRemoteCliBrowserWork', () => {
  it('returns page work unchanged outside a bridged command', async () => {
    const cancel = vi.fn()
    await expect(boundRemoteCliBrowserWork(Promise.resolve(1), cancel, 5)).resolves.toBe(1)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('stops a bridged page script at its deadline and cancels it', async () => {
    const cancel = vi.fn()
    const outcome = runInRemoteCliBrowserScope(HOST_WORKSPACE, () =>
      boundRemoteCliBrowserWork(new Promise(() => {}), cancel, 10)
    )

    await expect(outcome).rejects.toMatchObject({ code: 'browser_timeout' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('stops a bridged page script when the bridge detaches', async () => {
    const revoked = new AbortController()
    const cancel = vi.fn()
    const outcome = runInRemoteCliBrowserScope(
      HOST_WORKSPACE,
      () => boundRemoteCliBrowserWork(new Promise(() => {}), cancel, 60_000),
      revoked.signal
    )

    revoked.abort()

    await expect(outcome).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('lets a bridged script that finishes in time return its result', async () => {
    const cancel = vi.fn()
    const outcome = runInRemoteCliBrowserScope(HOST_WORKSPACE, () =>
      boundRemoteCliBrowserWork(Promise.resolve('done'), cancel, 60_000)
    )

    await expect(outcome).resolves.toBe('done')
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('captureRemoteCliBrowserRevocation guest routing', () => {
  it('refuses to run a queued command on a page that stopped browsing through the host', async () => {
    let routed = true
    const assertAdmitted = await runInRemoteCliBrowserScope(
      HOST_WORKSPACE,
      async () => captureRemoteCliBrowserRevocation(),
      new AbortController().signal,
      () => routed
    )

    expect(() => assertAdmitted(7)).not.toThrow()
    routed = false
    expect(() => assertAdmitted(7)).toThrow('not browsing through the SSH host')
    expect(() => assertAdmitted()).not.toThrow()
  })
})

describe('isHostReachableDocument', () => {
  it('refuses a page showing a desktop file, even in a routed tab', () => {
    expect(isHostReachableDocument('file:///Users/me/.ssh/id_ed25519')).toBe(false)
    expect(isHostReachableDocument('orca-doc://preview')).toBe(false)
    expect(isHostReachableDocument('chrome://settings')).toBe(false)
  })

  it('allows web documents and a page that has not loaded yet', () => {
    for (const url of [
      'https://a.test',
      'http://localhost:3000',
      'about:blank',
      'chrome-error://chromewebdata/',
      ''
    ]) {
      expect(isHostReachableDocument(url)).toBe(true)
    }
  })
})
