import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'
import { createProfile } from './client-hosted-browser-persistence-test-harness'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { BROWSER_CLIENT_HOST_METHODS } from '../../rpc/methods/browser/browser-client-host'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/browser/runtime/browser-runtime-capabilities'

class ReconciliationDeliveryRuntime extends OrcaRuntimeService {
  projectedFrames = 0
  sessionTabsSequence() {
    return this.mobileSessionTabsChangeSequence
  }
  protected override projectMobileSessionTabsForClient(
    result: RuntimeMobileSessionTabsResult,
    clientId?: string
  ) {
    this.projectedFrames += 1
    return super.projectMobileSessionTabsForClient(result, clientId)
  }
  peekSnapshotForClient(worktree: string, clientId: string) {
    return this.getMobileSessionTabsForWorktree(worktree, clientId, {
      includeAgentSenders: false
    })
  }
  snapshotForClient(worktree: string, clientId: string) {
    const result = this.peekSnapshotForClient(worktree, clientId)
    this.observeClientHostedPageSnapshots([result], clientId)
    return result
  }
  override getRuntimeId(): string {
    return 'runtime-a'
  }
}

export function createReconciliationDeliveryRuntime() {
  const profile = createProfile()
  const hostRuntime = new ReconciliationDeliveryRuntime(profile.store, undefined, {})
  const rpc = new RpcDispatcher({ runtime: hostRuntime, methods: BROWSER_CLIENT_HOST_METHODS })
  const streams: { stopped: AbortController; completion: Promise<void> }[] = []
  function attach() {
    const stopped = new AbortController()
    const completion = rpc.dispatchStreaming(
      {
        id: 'empty-adoption',
        authToken: 'test',
        method: 'browser.clientHost.attach',
        params: {
          authorityRuntimeId: 'runtime-a',
          browserHostClientId: 'client-a',
          hostCapabilities: ['webview'],
          pageCommandProtocolVersion: 1,
          pageReconciliationProtocolVersion: 1,
          pageInventoryProtocolVersion: 1,
          pageInventory: [],
          leaseReconnectProtocolVersion: 1
        }
      },
      () => {},
      {
        connectionId: 'empty-adoption',
        pairedDeviceId: 'device-a',
        clientKind: 'runtime',
        clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY],
        signal: stopped.signal
      }
    )
    streams.push({ stopped, completion })
    return { abort: () => stopped.abort(), completion }
  }
  return {
    hostRuntime,
    attach,
    async close() {
      for (const stream of streams) {
        stream.stopped.abort()
      }
      await Promise.all(streams.map((stream) => stream.completion))
    }
  }
}
