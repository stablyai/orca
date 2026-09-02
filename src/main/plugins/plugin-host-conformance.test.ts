import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_HOST_API_V0 } from '../../shared/plugins/plugin-host-api'
import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import {
  admitPluginPanelCall,
  createPluginPanelCallAdmission
} from '../../shared/plugins/plugin-panel-call-admission'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import type { MethodHandler } from '../../relay/dispatcher'
import {
  RELAY_PLUGIN_PANEL_HOST_CALL_METHOD,
  RELAY_PLUGIN_WORKER_HOST_CALL_METHOD,
  registerRelayPluginHostCallHandlers
} from '../../relay/plugin-host-call-handler'
import {
  executePluginHostCallRequest,
  type PluginHostCallPolicy,
  type ResolvePluginHostCallPolicy
} from './plugin-host-call-adapter'
import type { PluginHostServices } from './plugin-host-methods'

const PLUGIN_KEY = 'orca-samples.demo'
const WORKTREE_ID = 'repo-id::/Users/private/orca'
const TERMINAL_ID = 'terminal:local:one'

type HostCallAdapter = (request: unknown, viaPanel: boolean) => Promise<PluginPanelActionOutcome>

function createServices(): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue({
      worktreeId: WORKTREE_ID,
      branch: 'main',
      displayName: 'Orca',
      path: '/Users/private/orca'
    }),
    listWorktreeTerminals: vi
      .fn()
      .mockResolvedValue([{ id: TERMINAL_ID, title: '/home/private/orca' }]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: {
      get: vi.fn().mockReturnValue('stored'),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn(),
      keys: vi.fn().mockReturnValue(['alpha'])
    },
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: 'secret' }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn()
    },
    settings: {
      getAll: vi.fn().mockReturnValue({ theme: 'dark' }),
      set: vi.fn().mockReturnValue({ ok: true })
    },
    subscribeEvents: vi.fn().mockImplementation((_pluginKey, events) => events)
  }
}

function createPolicy(
  grantedCapabilities: readonly PluginCapabilityKind[] | null,
  services: PluginHostServices = createServices(),
  audit = { record: vi.fn().mockResolvedValue(undefined) }
): PluginHostCallPolicy {
  return { grantedCapabilities, services, audit }
}

function createAdapters(
  resolvePolicy: ResolvePluginHostCallPolicy,
  limits?: { maxBytes?: number; maxMessages?: number; perMs?: number }
): Record<string, HostCallAdapter> {
  const relayHandlers = new Map<string, MethodHandler>()
  registerRelayPluginHostCallHandlers(
    { onRequest: (method, handler) => relayHandlers.set(method, handler) },
    (context) => (context.clientId === 1 ? PLUGIN_KEY : null),
    resolvePolicy,
    { panelAdmission: createPluginPanelCallAdmission({ limits, now: () => 0 }) }
  )
  const desktopAdmission = createPluginPanelCallAdmission({ limits, now: () => 0 })
  return {
    'desktop-main': async (request, viaPanel) => {
      if (viaPanel) {
        const admissionRefusal = admitPluginPanelCall(desktopAdmission, PLUGIN_KEY, request)
        if (admissionRefusal) {
          return admissionRefusal
        }
      }
      return executePluginHostCallRequest({
        pluginKey: PLUGIN_KEY,
        request,
        viaPanel,
        resolvePolicy
      })
    },
    relay: async (request, viaPanel) => {
      const registeredMethod = viaPanel
        ? RELAY_PLUGIN_PANEL_HOST_CALL_METHOD
        : RELAY_PLUGIN_WORKER_HOST_CALL_METHOD
      return (await relayHandlers.get(registeredMethod)!(request as Record<string, unknown>, {
        clientId: 1,
        isStale: () => false
      })) as PluginPanelActionOutcome
    }
  }
}

const successParams: Record<string, unknown> = {
  'workspace.readContext': {},
  'terminal.sendText': { terminalId: TERMINAL_ID, text: 'echo hi', enter: true },
  'notifications.show': { title: 'Hello' },
  'storage.get': { key: 'alpha' },
  'storage.set': { key: 'alpha', value: 1 },
  'storage.delete': { key: 'alpha' },
  'storage.keys': {},
  'secrets.get': { key: 'token' },
  'secrets.set': { key: 'token', value: 'secret' },
  'secrets.delete': { key: 'token' },
  'settings.get': {},
  'settings.set': { key: 'theme', value: 'dark' },
  'events.subscribe': { events: ['worktree.created'] }
}

describe('plugin host main/relay conformance', () => {
  it('runs a granted success through both transports for all 13 v0 methods', async () => {
    expect(PLUGIN_HOST_API_V0).toHaveLength(13)
    expect(Object.keys(successParams).sort()).toEqual(
      PLUGIN_HOST_API_V0.map((entry) => entry.name).sort()
    )
    expect(PLUGIN_HOST_API_V0.every((entry) => entry.stability === 'experimental')).toBe(true)
    expect(PLUGIN_HOST_API_V0.every((entry) => entry.scope.length > 0)).toBe(true)

    for (const spec of PLUGIN_HOST_API_V0) {
      const policy = createPolicy([spec.capability])
      const resolvePolicy = vi.fn().mockResolvedValue(policy)
      const outcomes = await Promise.all(
        Object.values(createAdapters(resolvePolicy)).map((adapter) =>
          adapter({ method: spec.name, params: successParams[spec.name] }, spec.panel)
        )
      )
      expect(outcomes, spec.name).toHaveLength(2)
      expect(outcomes[0], spec.name).toEqual(outcomes[1])
      expect(outcomes[0], spec.name).toMatchObject({ ok: true })
    }
  })

  it('projects workspace context without host paths on main and relay', async () => {
    const resolvePolicy = vi.fn().mockResolvedValue(createPolicy(['workspace:read']))
    for (const adapter of Object.values(createAdapters(resolvePolicy))) {
      const outcome = await adapter({ method: 'workspace.readContext', params: {} }, true)
      expect(outcome).toEqual({
        ok: true,
        value: {
          branch: 'main',
          displayName: 'Orca',
          terminals: [{ id: TERMINAL_ID }]
        }
      })
      expect(outcome).not.toHaveProperty('value.path')
      expect(outcome).not.toHaveProperty('value.worktreeId')
    }
  })

  const deniedCases: {
    name: string
    request: unknown
    viaPanel: boolean
    policy: () => PluginHostCallPolicy
    code: string
  }[] = [
    {
      name: 'missing or stale consent',
      request: { method: 'workspace.readContext', params: {} },
      viaPanel: true,
      policy: () => createPolicy(null),
      code: 'consent_required'
    },
    {
      name: 'missing capability',
      request: { method: 'workspace.readContext', params: {} },
      viaPanel: true,
      policy: () => createPolicy([]),
      code: 'capability_denied'
    },
    {
      name: 'unknown method',
      request: { method: 'workspace.erase', params: {} },
      viaPanel: false,
      policy: () => createPolicy(['workspace:read']),
      code: 'unknown_method'
    },
    {
      name: 'malformed params',
      request: {
        method: 'terminal.sendText',
        params: { terminalId: TERMINAL_ID, text: '' }
      },
      viaPanel: true,
      policy: () => createPolicy(['terminal:send']),
      code: 'invalid_params'
    },
    {
      name: 'panel-forbidden method',
      request: { method: 'storage.get', params: { key: 'alpha' } },
      viaPanel: true,
      policy: () => createPolicy(['storage']),
      code: 'panel_forbidden'
    },
    {
      name: 'malformed result',
      request: {
        method: 'notifications.show',
        params: { title: 'Hello' }
      },
      viaPanel: true,
      policy: () => {
        const services = createServices()
        services.dispatchPluginNotification = vi
          .fn()
          .mockResolvedValue({ delivered: 'yes' } as unknown as { delivered: boolean })
        return createPolicy(['notifications:show'], services)
      },
      code: 'action_failed'
    },
    {
      name: 'mutation audit failure',
      request: {
        method: 'storage.set',
        params: { key: 'alpha', value: 1 }
      },
      viaPanel: false,
      policy: () =>
        createPolicy(['storage'], createServices(), {
          record: vi.fn().mockRejectedValue(new Error('disk full'))
        }),
      code: 'action_failed'
    }
  ]

  it.each(deniedCases)('returns identical $code codes for $name', async (testCase) => {
    const outcomes: PluginPanelActionOutcome[] = []
    for (const adapterName of ['desktop-main', 'relay']) {
      const resolvePolicy = vi.fn().mockImplementation(() => testCase.policy())
      const adapter = createAdapters(resolvePolicy)[adapterName]!
      outcomes.push(await adapter(testCase.request, testCase.viaPanel))
    }
    expect(outcomes[0]).toMatchObject({ ok: false, code: testCase.code })
    expect(outcomes[1]).toMatchObject({ ok: false, code: testCase.code })
    expect(outcomes[0]).toEqual(outcomes[1])
  })

  it('enforces the same per-plugin panel budget on desktop main and relay', async () => {
    for (const adapterName of ['desktop-main', 'relay']) {
      const resolvePolicy = vi.fn().mockResolvedValue(createPolicy(['notifications:show']))
      const adapter = createAdapters(resolvePolicy, {
        maxMessages: 1,
        perMs: 10_000
      })[adapterName]!

      await expect(
        adapter({ method: 'notifications.show', params: { title: 'first' } }, true)
      ).resolves.toMatchObject({ ok: true })
      await expect(
        adapter({ method: 'notifications.show', params: { title: 'second' } }, true)
      ).resolves.toEqual({
        ok: false,
        code: 'rate_limited',
        error: 'too many panel requests'
      })
    }
  })

  it('charges malformed and oversized panel traffic before schema parsing', async () => {
    for (const adapterName of ['desktop-main', 'relay']) {
      const resolvePolicy = vi.fn().mockResolvedValue(createPolicy(['notifications:show']))
      const adapter = createAdapters(resolvePolicy, {
        maxBytes: 128,
        maxMessages: 2,
        perMs: 10_000
      })[adapterName]!

      await expect(
        adapter({ method: 'notifications.show', unexpected: true }, true)
      ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
      await expect(
        adapter(
          {
            method: 'notifications.show',
            params: { title: 'x'.repeat(256) }
          },
          true
        )
      ).resolves.toEqual({
        ok: false,
        code: 'invalid_request',
        error: 'panel message exceeds the size limit'
      })
      await expect(
        adapter({ method: 'notifications.show', params: { title: 'third' } }, true)
      ).resolves.toEqual({
        ok: false,
        code: 'rate_limited',
        error: 'too many panel requests'
      })
      expect(resolvePolicy).not.toHaveBeenCalled()
    }
  })

  it('binds relay plugin identity to the requesting connection', async () => {
    const relayHandlers = new Map<string, MethodHandler>()
    const services = createServices()
    const resolvePolicy = vi.fn().mockResolvedValue(createPolicy(['storage'], services))
    const resolveIdentity = vi
      .fn()
      .mockImplementation(({ clientId }: { clientId: number }) =>
        clientId === 7 ? PLUGIN_KEY : null
      )
    registerRelayPluginHostCallHandlers(
      { onRequest: (method, handler) => relayHandlers.set(method, handler) },
      resolveIdentity,
      resolvePolicy
    )
    const handler = relayHandlers.get(RELAY_PLUGIN_WORKER_HOST_CALL_METHOD)!

    await expect(
      handler(
        { method: 'storage.get', params: { key: 'alpha' } },
        { clientId: 7, isStale: () => false }
      )
    ).resolves.toMatchObject({ ok: true })
    expect(services.storage.get).toHaveBeenCalledWith(PLUGIN_KEY, 'alpha')

    await expect(
      handler(
        { method: 'storage.get', params: { key: 'alpha' } },
        { clientId: 8, isStale: () => false }
      )
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(resolvePolicy).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed envelopes and client-supplied authority before policy resolution', async () => {
    const requests = [
      { pluginKey: '../evil', method: 'storage.get', params: { key: 'alpha' } },
      {
        pluginKey: PLUGIN_KEY,
        method: 'storage.get',
        params: { key: 'alpha' },
        grantedCapabilities: ['storage']
      },
      {
        pluginKey: PLUGIN_KEY,
        method: 'storage.get',
        params: { key: 'alpha' },
        viaPanel: false
      }
    ]
    for (const request of requests) {
      for (const adapterName of ['desktop-main', 'relay']) {
        const resolvePolicy = vi.fn().mockResolvedValue(createPolicy(['storage']))
        const outcome = await createAdapters(resolvePolicy)[adapterName]!(request, false)
        expect(outcome).toMatchObject({ ok: false, code: 'invalid_request' })
        expect(resolvePolicy).not.toHaveBeenCalled()
      }
    }
  })
})
