import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { loadAutomationAgents } from './automation-target-inventory'
import { automationClient, automationTargets, deferred } from './automation-test-fixtures'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'

const setup = automationTargets().setups[0]!
const qualified = 'preflight.host-qualified.v1'
const workspace = 'preflight.workspace-scoped.v1'

describe('selected automation discovery and explicit refresh', () => {
  it.each([
    [qualified, { worktreeId: 'repo-1::/repo', worktreeHostId: 'local' }],
    [workspace, { worktreeId: 'repo-1::/repo' }],
    ['', undefined]
  ] as const)('negotiates the answering host before sending (%s)', async (capability, params) => {
    const oldParser = z.object({ worktreeId: z.string().optional() })
    const port = automationClient((method, input) => {
      if (method === 'status.get') {
        return { hostPlatform: 'linux', capabilities: [capability] }
      }
      if (method === 'settings.getAgentLaunch') {
        return { settings: { defaultTuiAgent: 'pi', disabledTuiAgents: ['claude'] } }
      }
      if (method === 'preflight.detectAgents') {
        if (capability !== qualified) {
          expect(oldParser.parse(input ?? {})).not.toHaveProperty('worktreeHostId')
        }
        return ['claude', 'codex', 'pi']
      }
      throw new Error(method)
    })
    expect((await loadAutomationAgents(port.client, setup)).map((entry) => entry.agent)).toEqual([
      'pi',
      'codex'
    ])
    expect(port.send).toHaveBeenCalledWith('preflight.detectAgents', params)
    expect(port.send.mock.calls[0]?.[0]).toBe('status.get')
  })

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
    for (const [method, params, options] of send.mock.calls) {
      expect(options).toMatchObject({ envelope: { executionHost: 'runtime:server' } })
      if (method.startsWith('preflight.')) {
        expect(params).toEqual({ worktreeId: 'repo-1::/same', worktreeHostId: 'local' })
      }
    }
  })

  it.each(['unsupported', 'malformed'] as const)(
    'keeps discovery unavailable when selected agent settings are %s',
    async (failure) => {
      const port = automationClient((method) => {
        if (method === 'status.get') {
          return { capabilities: [qualified] }
        }
        if (method === 'settings.getAgentLaunch') {
          if (failure === 'unsupported') {
            throw new Error('method_not_supported')
          }
          return { settings: { disabledTuiAgents: 'codex' } }
        }
        if (method === 'preflight.detectAgents') {
          return ['codex']
        }
        throw new Error(method)
      })
      await expect(loadAutomationAgents(port.client, setup)).rejects.toThrow()
      expect(port.send).toHaveBeenCalledWith('settings.getAgentLaunch')
      expect(port.send.mock.calls.some(([method]) => method === 'settings.get')).toBe(false)
    }
  )

  it('fences before a generation-changing status reply and never probes SSH or unverified old Windows', async () => {
    const status = deferred<unknown>()
    const port = automationClient(() => status.promise)
    const pending = loadAutomationAgents(port.client, setup)
    port.state('connected')
    status.resolve({ capabilities: [qualified], hostPlatform: 'linux' })
    await expect(pending).rejects.toThrow('connection changed')
    expect(port.send).toHaveBeenCalledTimes(1)
    await expect(
      loadAutomationAgents(port.client, { ...setup, hostId: 'ssh:other' })
    ).rejects.toThrow('unavailable')
    expect(port.send).toHaveBeenCalledTimes(1)
    const old = automationClient(() => ({ capabilities: [], hostPlatform: 'win32' }))
    await expect(loadAutomationAgents(old.client, setup)).rejects.toThrow('cannot verify')
    expect(old.send).toHaveBeenCalledTimes(1)
  })

  it('supersedes an older detect with refresh on the exact tuple', async () => {
    const detect = deferred<unknown>()
    const started = deferred<void>()
    const port = automationClient((method) => {
      if (method === 'status.get') {
        return { capabilities: [qualified] }
      }
      if (method === 'settings.getAgentLaunch') {
        return { settings: {} }
      }
      if (method === 'preflight.detectAgents') {
        started.resolve()
        return detect.promise
      }
      return {
        agents: ['pi'],
        addedPathSegments: [],
        shellHydrationOk: true,
        pathSource: 'shell_hydrate',
        pathFailureReason: 'none'
      }
    })
    const old = loadAutomationAgents(port.client, setup)
    const rejected = expect(old).rejects.toThrow()
    await started.promise
    expect(
      (await loadAutomationAgents(port.client, setup, undefined, true)).map((entry) => entry.agent)
    ).toEqual(['pi'])
    detect.resolve(['claude'])
    await rejected
  })
})
