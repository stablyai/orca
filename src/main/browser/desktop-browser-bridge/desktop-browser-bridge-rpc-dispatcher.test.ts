import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE
} from '../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { executeDesktopBrowserBridgeRequest } from './desktop-browser-bridge-executor'
import { DesktopBrowserBridgeHostFiles } from './desktop-browser-bridge-host-files'
import {
  createDesktopBrowserBridgeRpcDispatcher,
  dispatchDesktopBrowserBridgeRpc
} from './desktop-browser-bridge-rpc-dispatcher'

function bridge() {
  const runtime = new OrcaRuntimeService(null)
  const tabList = vi.spyOn(runtime, 'browserTabList').mockResolvedValue({ tabs: [] })
  const cookieGet = vi
    .spyOn(runtime, 'browserCookieGet')
    .mockRejectedValue(new Error('unreachable'))
  const dispatcher = createDesktopBrowserBridgeRpcDispatcher(runtime)
  const tabCreate = vi
    .spyOn(runtime, 'browserTabCreate')
    .mockRejectedValue(new Error('unreachable'))
  const dispatch = vi.fn((method: string, params: Record<string, unknown>) =>
    dispatchDesktopBrowserBridgeRpc(dispatcher, method, params)
  )
  const hostFiles = new DesktopBrowserBridgeHostFiles({
    stagingRoot: path.join(tmpdir(), `orca-bridge-test-${process.pid}`),
    hostLabel: () => 'host'
  })
  const execute = (method: string, signal?: AbortSignal) =>
    executeDesktopBrowserBridgeRequest(
      { type: 'request', requestId: 'r1', method, workspaceId: 'wt-1', params: {} },
      {
        environmentId: 'env-1',
        targetId: 'ssh-1',
        hostLabel: 'host',
        resolveWorkspace: async () => 'wt-1',
        worktreeIdForPage: () => null,
        markWorkspaceDriven: () => {},
        isHostBrowsingRouted: () => true,
        isGuestRoutedThroughHost: () => true,
        dispatch,
        hostFiles,
        audit: () => {}
      },
      signal
    )
  return { dispatcher, dispatch, execute, tabList, cookieGet, tabCreate }
}

describe('desktop browser bridge restricted dispatcher', () => {
  it('serves an allowed browser method from its lazy group', async () => {
    const { execute, tabList } = bridge()
    await expect(execute('browser.tabList')).resolves.toEqual({ ok: true, result: { tabs: [] } })
    expect(tabList).toHaveBeenCalledWith(expect.objectContaining({ worktree: 'id:wt-1' }))
  })

  it('does not register browser methods outside the allowlist', async () => {
    const { dispatcher, execute, dispatch, cookieGet } = bridge()
    const refused = await execute('browser.cookie.get')
    expect(refused).toMatchObject({
      ok: false,
      error: { code: DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE }
    })
    expect(dispatch).not.toHaveBeenCalled()
    // Load the shared browser group, then a misrouted call that skips the executor allowlist still finds nothing.
    await execute('browser.tabList')
    const misrouted = await dispatcher.dispatch(
      { id: 'req', authToken: '', method: 'browser.cookie.get', params: {} },
      { caller: { kind: 'local-cli' } }
    )
    expect(misrouted).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(cookieGet).not.toHaveBeenCalled()
  })

  it('refuses an allowed method once the bridge is revoked', async () => {
    const { execute, dispatch, tabList } = bridge()
    const revoked = new AbortController()
    revoked.abort()
    const outcome = await execute('browser.tabList', revoked.signal)
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE }
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(tabList).not.toHaveBeenCalled()
  })

  it('refuses a command whose bridge is revoked while its lazy group loads', async () => {
    const { dispatcher, execute, tabCreate } = bridge()
    const revoked = new AbortController()
    const load = dispatcher.ensureMethodLoaded.bind(dispatcher)
    vi.spyOn(dispatcher, 'ensureMethodLoaded').mockImplementation(async (method) => {
      const loading = load(method)
      revoked.abort()
      await loading
    })
    const dispatchAfterLoad = vi.spyOn(dispatcher, 'dispatch')
    const outcome = await execute('browser.tabCreate', revoked.signal)
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE }
    })
    expect(dispatchAfterLoad).not.toHaveBeenCalled()
    expect(tabCreate).not.toHaveBeenCalled()
  })
})
