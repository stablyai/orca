import { RpcDispatcher } from '../../rpc/dispatcher'
import { BROWSER_CORE_METHODS } from '../../rpc/methods/browser/browser-core'
import { RuntimeBrowserTabCreation } from '../tabs/browser-tab-creation'
import type { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { vi } from 'vitest'
import { orcadClientPageCommand } from '../../../orcad/orcad-client-page-commands'
import type { RuntimeBrowserCommandHost } from '../commands/browser-command-contracts'

export function ordinaryPageRpc(h: ReturnType<typeof createRecoveryLoop>, remote = false) {
  h.native.dependencies.retainNetworkRoute.mockImplementation(async (key) => ({
    ...h.native.route,
    key
  }))
  const host: RuntimeBrowserCommandHost = {
    getRuntimeId: () => 'runtime-a',
    resolveWorkspaceSelector: async () => ({ id: 'repo-1::/tmp/worktree-a' }),
    getAgentBrowserBridge: () => null,
    resolveBrowserWorkspace: async () => ({ id: 'repo-1::/tmp/worktree-a' }),
    resolveBrowserNetworkExecutionHost: async () => ({
      kind: 'native',
      runtimeId: 'runtime-a',
      revision: 1
    }),
    getBrowserHostLeaseRegistry: () => h.authority,
    getBrowserHostRequestRegistry: () => {
      throw new Error('unexpected_host_volunteer')
    },
    getRuntimeBrowserPageRegistry: () => h.pages,
    getAvailableAuthoritativeWindow: () => null,
    getOffscreenBrowserBackend: () => null,
    getAuthoritativeWindow: () => {
      throw new Error('unexpected_host_window')
    },
    notifyHeadlessBrowserSessionTabsChanged: (id) =>
      h.hostRuntime.notifyMobileSessionTabsChanged(id)
  }
  const creation = new RuntimeBrowserTabCreation(host, {
    requireAgentBrowserBridge: () => {
      throw new Error('unexpected_bridge')
    },
    notifyRendererNavigation: () => {}
  })
  vi.spyOn(h.hostRuntime, 'browserTabCreate').mockImplementation(
    remote
      ? async (...args) =>
          orcadClientPageCommand(
            host,
            'browserTabCreate',
            () => {
              throw new Error('unexpected_engine')
            },
            () => false
          )!(...args)
      : creation.browserTabCreate.bind(creation)
  )
  vi.spyOn(h.hostRuntime, 'browserOpenUrlOnClient').mockImplementation(
    remote
      ? async (...args) =>
          orcadClientPageCommand(
            host,
            'browserOpenUrlOnClient',
            () => {
              throw new Error('unexpected_engine')
            },
            () => false
          )!(...args)
      : creation.browserOpenUrlOnClient.bind(creation)
  )
  const rpc = new RpcDispatcher({ runtime: h.hostRuntime, methods: BROWSER_CORE_METHODS })
  return async (
    method: 'browser.tabCreate' | 'browser.openUrl',
    page: string,
    signal: AbortSignal,
    url = 'https://example.internal/new'
  ) => {
    const replies: { ok: boolean; error?: { message: string } }[] = []
    await rpc.dispatchStreaming(
      {
        id: page,
        authToken: 'test',
        method,
        params:
          method === 'browser.tabCreate'
            ? {
                worktree: 'id:repo-1::/tmp/worktree-a',
                page,
                ...(remote
                  ? {}
                  : { placement: { kind: 'client', browserHostClientId: 'client-a' } })
              }
            : { worktree: 'id:repo-1::/tmp/worktree-a', url }
      },
      (text) => replies.push(JSON.parse(text)),
      {
        ...h.caller(),
        ...(remote ? { pairedDeviceId: undefined, clientKind: undefined } : {}),
        signal
      }
    )
    return replies
  }
}
