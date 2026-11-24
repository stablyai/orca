import { expect, it, vi } from 'vitest'
import { executePluginHostCall } from './host-api/plugin-host-methods'
import type { PluginHostServices } from './host-api/plugin-host-method-bindings'
import { pluginHostCallRevoked } from './host-api/plugin-host-call-scope'

const params = { id: 'run', requestId: 'pause', expectedRevision: 3 }
function fixture(pluginKey = 'samples.pipelines') {
  const runtimeRpc = vi.fn(
    async (method: string, _params: unknown, options?: { beforeEffect?: () => void }) => {
      if (method === 'pipeline.status') {
        return {
          run: {
            id: 'run',
            workspace: { id: 'repo::task' },
            provider: { pluginKey },
            profile: { title: 'Development' },
            stage: 'plan',
            state: 'running',
            revision: 3,
            fixCycles: 0
          }
        }
      }
      options?.beforeEffect?.()
      return {}
    }
  )
  const services: PluginHostServices = {
    resolveActiveWorktreeContext: async () => null,
    listWorktreeTerminals: async () => [],
    sendTerminalText: async () => ({ accepted: true }),
    listAgentStatuses: () => [],
    dispatchPluginNotification: async () => ({ delivered: true }),
    runtimeRpc,
    storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: () => [] },
    secrets: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), protection: () => 'unavailable' },
    settings: { getAll: () => ({}), set: vi.fn() }
  }
  const call = (
    options: { surface?: 'panel' | 'worker'; assertActive?: () => void; audit?: boolean } = {}
  ) =>
    executePluginHostCall({
      pluginId: 'samples.pipelines',
      method: 'pipeline.pause',
      params,
      surface: options.surface ?? 'panel',
      grantedCapabilities: ['workspace:read'],
      services,
      audit: options.audit === false ? undefined : { record: vi.fn().mockResolvedValue(undefined) },
      scope: { assertActive: options.assertActive ?? (() => undefined) }
    })
  return { call, runtimeRpc }
}

it('denies a foreign profile and worker controls before a pipeline mutation', async () => {
  const { call, runtimeRpc } = fixture('other.pipelines')
  expect(await call()).toMatchObject({ ok: false, code: 'not_permitted' })
  expect(await call({ surface: 'worker' })).toMatchObject({ ok: false, code: 'not_permitted' })
  expect(runtimeRpc.mock.calls.some(([method]) => method === 'pipeline.pause')).toBe(false)
})

it('requires mutation auditing and rechecks approval after the ownership read', async () => {
  const { call, runtimeRpc } = fixture()
  expect(await call({ audit: false })).toMatchObject({ ok: false, code: 'unavailable' })
  expect(runtimeRpc).not.toHaveBeenCalled()
  let approved = true
  runtimeRpc.mockImplementationOnce(async () => {
    approved = false
    return {
      run: {
        id: 'run',
        workspace: { id: 'repo::task' },
        provider: { pluginKey: 'samples.pipelines' },
        profile: { title: 'Development' },
        stage: 'plan',
        state: 'running',
        revision: 3,
        fixCycles: 0
      }
    }
  })
  expect(
    await call({
      assertActive: () => {
        if (!approved) {
          throw pluginHostCallRevoked()
        }
      }
    })
  ).toMatchObject({ ok: false, code: 'consent_required' })
  expect(runtimeRpc.mock.calls.some(([method]) => method === 'pipeline.pause')).toBe(false)
})
