import type { RpcClient } from '../transport/rpc-client'
import { SessionSnapshotFixture } from './mobile-web-session-snapshot-fixture'

// Fake Desktop transport for legacy RPC fixtures; page requests still traverse the generic broker.
export function sessionHostFixture(client: RpcClient): RpcClient {
  const snapshots = new SessionSnapshotFixture()
  const reply = (result: unknown) => ({
    id: 'fixture',
    _meta: { runtimeId: 'fixture' },
    ok: true as const,
    result
  })
  return new Proxy(client, {
    get(target, key) {
      if (key === 'subscribe') {
        return (
          method: string,
          input: Record<string, unknown>,
          listener: (event: unknown) => void,
          options?: unknown
        ) => {
          if (method !== 'mobileWeb.session.subscribe') {
            return target.subscribe(method, input, listener, options as never)
          }
          return target.subscribe(
            'session.tabs.subscribe',
            { worktree: input.worktree },
            (event) => {
              try {
                listener({
                  type: 'snapshot',
                  snapshot: snapshots.project(
                    event,
                    String(input.worktree),
                    String(input.workspaceId)
                  )
                })
              } catch {
                listener({ type: 'error', message: 'invalid snapshot fixture' })
              }
            }
          )
        }
      }
      if (key !== 'sendRequest') {
        return Reflect.get(target, key)
      }
      return async (method: string, input: Record<string, unknown>, options?: unknown) => {
        if (method === 'mobileWeb.session.snapshot' || method === 'mobileWeb.session.activate') {
          const response = await target.sendRequest(
            method === 'mobileWeb.session.snapshot' ? 'session.tabs.list' : 'session.tabs.activate',
            {
              worktree: input.worktree,
              ...(method === 'mobileWeb.session.activate'
                ? { tabId: input.tabId, notifyClients: false, navigation: 'caller' }
                : {})
            }
          )
          if (!response.ok) {
            return response
          }
          return reply(
            snapshots.project(response.result, String(input.worktree), String(input.workspaceId))
          )
        }
        if (method === 'mobileWeb.session.createBrowser') {
          const response = await target.sendRequest('browser.tabCreate', {
            worktree: input.worktree,
            url: input.url,
            activate: true
          })
          if (!response.ok) {
            return response
          }
          const result = response.result as { browserPageId: string }
          return reply({ workspaceId: input.workspaceId, browserPageId: result.browserPageId })
        }
        if (method === 'mobileWeb.session.close') {
          const response = await target.sendRequest('session.tabs.close', {
            worktree: input.worktree,
            tabId: input.tabId,
            reason: 'user'
          })
          if (!response.ok) {
            return response
          }
          return reply({
            workspaceId: input.workspaceId,
            tabId: input.tabId,
            outcome: 'closed',
            refusalReason: null
          })
        }
        return options === undefined
          ? target.sendRequest(method, input)
          : target.sendRequest(method, input, options as never)
      }
    }
  })
}
