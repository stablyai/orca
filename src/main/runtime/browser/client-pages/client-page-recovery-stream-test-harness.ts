import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../rpc/methods/session-tabs/session-tabs'

export function openRecoveryTabsStream(
  runtime: OrcaRuntimeService,
  id: string,
  worktree?: string,
  deviceId = 'device-a',
  clientKind: 'mobile' | 'runtime' = 'mobile'
) {
  const stopped = new AbortController()
  const frames: RuntimeMobileSessionTabsResult[] = []
  const errors: unknown[] = []
  const initial = Promise.withResolvers<void>()
  const rpc = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const completion = rpc.dispatchStreaming(
    {
      id,
      authToken: 'test',
      method: worktree ? 'session.tabs.subscribe' : 'session.tabs.subscribeAll',
      params: worktree ? { worktree } : {}
    },
    (reply) => {
      const message: {
        ok?: boolean
        error?: unknown
        result?:
          | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[] }
          | ({ type: 'snapshot' | 'updated' } & RuntimeMobileSessionTabsResult)
      } = JSON.parse(reply)
      if (message.ok === false) {
        errors.push(message.error)
        initial.reject(new Error('session-stream-failed'))
      }
      const result = message.result
      if (result?.type === 'snapshots') {
        frames.push(...result.snapshots)
        initial.resolve()
      } else if (result?.type === 'snapshot' || result?.type === 'updated') {
        frames.push(result)
        initial.resolve()
      }
    },
    { connectionId: id, pairedDeviceId: deviceId, clientKind, signal: stopped.signal }
  )
  return { frames, errors, initial: initial.promise, completion, stop: () => stopped.abort() }
}

export async function publishRecoveryTabsGraph(runtime: OrcaRuntimeService): Promise<void> {
  runtime.attachWindow(1)
  await runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: 'repo-1::/tmp/worktree-a',
        publicationEpoch: 'renderer',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    ]
  })
}
