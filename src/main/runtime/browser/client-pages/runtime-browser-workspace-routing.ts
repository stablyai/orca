import {
  actOnRuntimeBrowserInitialization,
  captureRuntimeBrowserInitializationAction
} from './runtime-browser-page-initialization-action'
import type { BrowserPageInitializationActionParams } from '../../../../shared/browser/client-hosting/browser-page-initialization-action'
import type { z } from 'zod'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'
import '../../../browser/network/execution-routes/browser-network-execution-route'
import { browserNetworkExecutionHostKey } from '../../../../shared/browser/client-hosting/browser-network-execution-host'
import {
  type ClientHostedBrowserRpcRoute,
  routeRuntimeBrowserClientAutomation
} from './runtime-browser-client-automation'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry-instance'
import {
  routeDesktopBrowserBridgeRpc,
  type DesktopBrowserBridgeRoute
} from '../../desktop-browser-bridge/desktop-browser-bridge-route'
import {
  getDesktopBrowserBridgeRegistry,
  isDesktopBrowserBridgeHostEnabled
} from '../../desktop-browser-bridge/desktop-browser-bridge-registry'
import { runtimeBrowserCommandsFactoryIsAvailable } from '../installation/runtime-browser-commands-factory'
import { hasPairedPageHost } from './browser-client-page-opening'
import { resolveRemoteCliBrowserScopeSelector } from '../../desktop-browser-bridge/remote-cli-browser-scope'
import type { RpcContext } from '../../rpc/core'
import { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from '../../session-graph/session-graph-authority'

export abstract class OrcaRuntimeWithBrowserWorkspaceRouting extends OrcaRuntimeWithTransitionGraphReloadToTerminalState {
  async actOnClientPageInitialization(
    params: z.infer<typeof BrowserPageInitializationActionParams>
  ): Promise<void> {
    const pages = getRuntimeBrowserPageRegistry(this)
    const authority = getBrowserHostLeaseRegistry(this)
    const current = captureRuntimeBrowserInitializationAction(
      pages,
      authority,
      params.page,
      params.expectedPlacement
    )
    const workspace = await this.resolveBrowserWorkspace(params.worktree)
    const page = current()
    if (page.workspaceId !== workspace.id) {
      throw new Error('browser_page_workspace_mismatch')
    }
    const completion = actOnRuntimeBrowserInitialization({
      pages,
      authority,
      page,
      action: params.action,
      explicitUrl: true,
      resolveExecutionHostKey: (id) => this.resolveBrowserExecutionHostKeyForWorkspace(id),
      notifyWorkspace: (id) => this.notifyMobileSessionTabsChanged(id)
    })
    // This UI action acknowledges accepted intent; the command owns load completion.
    void completion.catch(() => {})
  }

  /** Resolve the current host key; native/WSL runtime ids and SSH provider epochs expire on restart. Missing workspaces are gone; reconnect/repair is temporary and never authorizes page retirement. */
  async resolveBrowserExecutionHostKeyForWorkspace(
    workspaceId: string
  ): Promise<BrowserExecutionHostKeyResolution> {
    let worktree: ResolvedWorktree
    try {
      worktree = await this.resolveBrowserWorkspace(`id:${workspaceId}`)
    } catch {
      return { status: 'workspace-gone' }
    }
    try {
      return {
        status: 'resolved',
        executionHostKey: browserNetworkExecutionHostKey(
          await this.resolveBrowserNetworkExecutionHostForWorktree(worktree)
        )
      }
    } catch {
      return { status: 'unavailable' }
    }
  }

  routeClientHostedBrowserRpc(
    method: string,
    params: unknown,
    caller: RpcContext['caller']
  ): Promise<ClientHostedBrowserRpcRoute> {
    return routeRuntimeBrowserClientAutomation({
      method,
      params,
      caller,
      pages: getRuntimeBrowserPageRegistry(this),
      leases: getBrowserHostLeaseRegistry(this),
      resolveExecutionHostKey: (id) => this.resolveBrowserExecutionHostKeyForWorkspace(id),
      notifyWorkspace: (id) => this.notifyMobileSessionTabsChanged(id),
      resolveWorkspace: (selector) =>
        resolveRemoteCliBrowserScopeSelector(selector) ?? this.resolveBrowserWorkspace(selector)
    })
  }

  /** On orcad, sends this host's CLI browser commands to the desktop that opted in to serve them. */
  routeDesktopBrowserBridgeRpc(
    method: string,
    params: unknown,
    context: Pick<RpcContext, 'caller' | 'signal'>
  ): Promise<DesktopBrowserBridgeRoute> {
    return routeDesktopBrowserBridgeRpc({
      method,
      params,
      caller: context.caller,
      signal: context.signal,
      hostEnabled: isDesktopBrowserBridgeHostEnabled(),
      registry: getDesktopBrowserBridgeRegistry(this),
      // This runtime lists/retires desktop-hosted pages even while their desktop is gone, so those commands need no bridge.
      localBrowserAvailable:
        runtimeBrowserCommandsFactoryIsAvailable() ||
        getRuntimeBrowserPageRegistry(this).listPages().length > 0 ||
        hasPairedPageHost({ getBrowserHostLeaseRegistry: () => getBrowserHostLeaseRegistry(this) }),
      resolveWorkspace: (selector) => this.resolveBrowserWorkspace(selector)
    })
  }
}
