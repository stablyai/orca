import { describe, expect, it, vi } from 'vitest'
import { loadAutomationAgents } from './automation-target-inventory'
import { automationClient, automationTargets } from './automation-test-fixtures'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'

const setup = automationTargets().setups[0]!
const qualified = 'preflight.host-qualified.v1'

describe('selected automation discovery and explicit refresh', () => {
  it('uses only the selected delegated client for status, settings, detect and refresh', async () => {
    const port = automationClient((method) => {
      if (method === 'status.get') {
        return { capabilities: [qualified], hostPlatform: 'win32' }
      }
      if (method === 'settings.getAgentLaunch') {
        return { settings: {} }
      }
      if (method === 'preflight.refreshAgents') {
        return {
          agents: ['codex'],
          addedPathSegments: [],
          shellHydrationOk: true,
          pathSource: 'sync_seed_only',
          pathFailureReason: 'none'
        }
      }
      return ['codex']
    })
    const send = vi.spyOn(port.client, 'sendRequest')
    const scoped = scopeRpcClientToExecutionHost(port.client, 'runtime:server')
    await loadAutomationAgents(scoped, setup, 'repo-1::/same')
    await loadAutomationAgents(scoped, setup, 'repo-1::/same', true)
    const statusCalls = send.mock.calls.filter(([method]) => method === 'status.get')
    expect(statusCalls.length).toBeGreaterThan(0)
    expect(statusCalls.length % 2).toBe(0)
    for (let index = 0; index < statusCalls.length; index += 2) {
      const destination = statusCalls[index]
      const origin = statusCalls[index + 1]
      expect(destination?.[1]).toBeUndefined()
      expect(origin?.[1]).toBeUndefined()
      expect(destination?.[2]).toEqual({ envelope: { executionHost: 'runtime:server' } })
      const { executionHost: _route, ...originEnvelope } = destination?.[2]?.envelope ?? {}
      expect(origin?.[2]).toEqual({ ...destination?.[2], envelope: originEnvelope })
    }
    for (const [method, params, options] of send.mock.calls) {
      if (method === 'status.get') {
        continue
      }
      expect(options).toMatchObject({ envelope: { executionHost: 'runtime:server' } })
      if (method.startsWith('preflight.')) {
        expect(params).toEqual({ worktreeId: 'repo-1::/same', worktreeHostId: 'local' })
      }
    }
  })
})
