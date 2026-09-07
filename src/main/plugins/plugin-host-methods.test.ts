import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../shared/plugins/plugin-host-api'
import { PANEL_MESSAGE_MAX_BYTES } from '../../shared/plugins/plugin-panel-bridge'
import { structuredCloneMessageBytes } from '../../shared/plugins/plugin-panel-message-budget'
import { getLocalExecutionHostLabel } from '../../shared/execution-host'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import { buildSidecarPlacement } from '../../shared/plugins/plugin-sidecar-contract'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'
import { AgentSessionPtyWriteRefusedError } from '../../shared/agent-session-pty-write-admission'
import { PluginKvStore } from './plugin-storage-store'
import { PluginSidecarMailbox } from './plugin-sidecar-mailbox'

function settingsBlobThatFitsOnlyWithoutOutcomeWrapper(): string {
  const wrap = (blob: string): { inner: number; wrapped: number } => {
    const value = { settings: { blob } }
    return {
      inner: structuredCloneMessageBytes(value),
      wrapped: structuredCloneMessageBytes({ ok: true, value })
    }
  }
  let low = 1
  let high = PANEL_MESSAGE_MAX_BYTES
  let found = ''
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const blob = 'x'.repeat(mid)
    const { inner, wrapped } = wrap(blob)
    if (inner <= PANEL_MESSAGE_MAX_BYTES && wrapped > PANEL_MESSAGE_MAX_BYTES) {
      found = blob
      break
    }
    if (wrapped <= PANEL_MESSAGE_MAX_BYTES) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (!found) {
    throw new Error('could not find a settings blob on the panel outcome boundary')
  }
  return found
}

const settingsRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    settingsRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

const emptySidecarPlacement = buildSidecarPlacement(null)

function createServices(storageSet: PluginHostServices['storage']['set']): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: {
      get: vi.fn(),
      set: storageSet,
      delete: vi.fn(),
      keys: vi.fn().mockReturnValue([])
    },
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: null }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn()
    },
    settings: {
      getAll: vi.fn().mockReturnValue({}),
      set: vi.fn().mockReturnValue({ ok: true })
    },
    subscribeEvents: vi.fn().mockReturnValue([]),
    readFocusedSurface: vi.fn().mockReturnValue(null),
    sidecar: {
      resolvePlacement: vi.fn().mockReturnValue(emptySidecarPlacement),
      publish: vi.fn().mockReturnValue({
        accepted: true,
        delivery: 'stored',
        placement: emptySidecarPlacement
      })
    }
  }
}

describe('executePluginHostCall mutation auditing', () => {
  it('rejects prototype-sensitive storage keys before any host service call', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: '__proto__', value: 42 },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('rejects non-JSON storage values before any host service call', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'created', value: new Date() },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('fails closed before a mutation when the audit intent cannot be recorded', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockRejectedValue(new Error('disk full')) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('records an intent before the mutation and its outcome afterward', async () => {
    const order: string[] = []
    const storageSet = vi.fn(() => {
      order.push('mutation')
      return { ok: true as const }
    })
    const record = vi.fn(async (entry: { outcome: string }) => {
      order.push(`audit:${entry.outcome}`)
    })

    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(storageSet),
      audit: { record }
    })

    expect(outcome).toEqual({ ok: true, value: { ok: true } })
    expect(order).toEqual(['audit:attempt', 'mutation', 'audit:ok'])
  })

  it('refuses mutations when no audit writer is configured', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(storageSet)
    })

    expect(outcome).toMatchObject({ ok: false, code: 'unavailable' })
    expect(storageSet).not.toHaveBeenCalled()
  })
})

function createTerminalHarness(
  terminalHandles: string[],
  extras: {
    hostId?: string
    createdWithAgent?: string
    readContextSources?: Parameters<typeof bindPluginHostServices>[0]['readContextSources']
  } = {}
): {
  delegate: PluginRuntimeDelegate
  services: PluginHostServices
} {
  const delegate: PluginRuntimeDelegate = {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue({
      worktreeId: 'worktree-1',
      path: '/Users/private/repo',
      branch: 'main',
      displayName: 'Repo',
      ...(extras.hostId ? { hostId: extras.hostId } : {}),
      ...(extras.createdWithAgent ? { createdWithAgent: extras.createdWithAgent } : {})
    }),
    listTerminals: vi.fn().mockResolvedValue({
      terminals: terminalHandles.map((handle) => ({ handle, title: null }))
    }),
    sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true })
  }
  return {
    delegate,
    services: bindPluginHostServices({
      delegate,
      pluginsDataDir: join(tmpdir(), 'plugin-host-methods-test'),
      subscribeEvents: vi.fn().mockReturnValue([]),
      ...(extras.readContextSources ? { readContextSources: extras.readContextSources } : {})
    })
  }
}

async function sendTerminalText(
  services: PluginHostServices,
  terminalId: string
): ReturnType<typeof executePluginHostCall> {
  return executePluginHostCall({
    pluginId: 'orca-samples.demo',
    method: 'terminal.sendText',
    params: { terminalId, text: 'echo hi', enter: true },
    viaPanel: true,
    grantedCapabilities: ['terminal:send'],
    services,
    audit: { record: vi.fn().mockResolvedValue(undefined) }
  })
}

describe('terminal.sendText explicit worktree routing', () => {
  it('performs one bounded list and zero sends when the terminal is outside the worktree', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:other'])

    const outcome = await sendTerminalText(services, 'terminal:ssh:requested')

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(delegate.resolveActiveWorktreeContext).toHaveBeenCalledTimes(1)
    expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
    expect(delegate.listTerminals).toHaveBeenCalledWith(
      'id:worktree-1',
      PLUGIN_WORKSPACE_TERMINAL_LIMIT,
      { includeVisualLayouts: false }
    )
    expect(delegate.sendTerminal).not.toHaveBeenCalled()
  })

  it.each(['terminal:local:one', 'terminal:ssh:opaque-provider-id'])(
    'performs one bounded list and one send for provider-agnostic id %s',
    async (terminalId) => {
      const { delegate, services } = createTerminalHarness([terminalId])

      const outcome = await sendTerminalText(services, terminalId)

      expect(outcome).toEqual({ ok: true, value: { accepted: true } })
      expect(delegate.resolveActiveWorktreeContext).toHaveBeenCalledTimes(1)
      expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
      expect(delegate.listTerminals).toHaveBeenCalledWith(
        'id:worktree-1',
        PLUGIN_WORKSPACE_TERMINAL_LIMIT,
        { includeVisualLayouts: false }
      )
      expect(delegate.sendTerminal).toHaveBeenCalledTimes(1)
      expect(delegate.sendTerminal).toHaveBeenCalledWith(terminalId, {
        text: 'echo hi',
        enter: true
      })
      expect(vi.mocked(delegate.listTerminals).mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(delegate.sendTerminal).mock.invocationCallOrder[0]!
      )
    }
  )

  it('bounds workspace.readContext and omits the provider path', async () => {
    const handles = Array.from(
      { length: PLUGIN_WORKSPACE_TERMINAL_LIMIT + 10 },
      (_, index) => `terminal:local:${index}`
    )
    const { delegate, services } = createTerminalHarness(handles)

    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.readContext',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['workspace:read'],
      services
    })

    expect(outcome).toMatchObject({
      ok: true,
      value: { branch: 'main', displayName: 'Repo' }
    })
    expect(outcome).not.toHaveProperty('value.path')
    expect(outcome).not.toHaveProperty('value.worktreeId')
    expect(outcome.ok && (outcome.value as { terminals: unknown[] }).terminals).toHaveLength(
      PLUGIN_WORKSPACE_TERMINAL_LIMIT
    )
    expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
    expect(outcome).not.toHaveProperty('value.executionHost')
    expect(outcome).not.toHaveProperty('value.agent')
  })

  it('projects additive executionHost and agent labels when the host knows them', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:one'], {
      hostId: 'ssh:build-box',
      createdWithAgent: 'codex',
      readContextSources: {
        hostLabelSources: () => ({
          hostLabelById: new Map([['ssh:build-box', 'Build box']])
        }),
        listAgentStatuses: () => [
          {
            worktreeId: 'worktree-1',
            state: 'working',
            agentType: 'claude',
            model: 'opus-4',
            receivedAt: 10
          }
        ],
        getProfileLabel: () => 'Personal'
      }
    })

    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.readContext',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['workspace:read'],
      services
    })

    expect(outcome).toEqual({
      ok: true,
      value: {
        branch: 'main',
        displayName: 'Repo',
        terminals: [{ id: 'terminal:local:one' }],
        executionHost: { kind: 'ssh', label: 'Build box' },
        agent: { type: 'claude', model: 'opus-4', profile: 'Personal' }
      }
    })
    expect(outcome).not.toHaveProperty('value.path')
    expect(outcome).not.toHaveProperty('value.worktreeId')
    expect(outcome).not.toHaveProperty('value.hostId')
    expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
  })

  it('projects a local host label and createdWithAgent when no live status exists', async () => {
    const { services } = createTerminalHarness(['terminal:local:one'], {
      hostId: 'local',
      createdWithAgent: 'codex',
      readContextSources: {
        getProfileLabel: () => 'Personal'
      }
    })

    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.readContext',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['workspace:read'],
      services
    })

    expect(outcome).toEqual({
      ok: true,
      value: {
        branch: 'main',
        displayName: 'Repo',
        terminals: [{ id: 'terminal:local:one' }],
        executionHost: { kind: 'local', label: getLocalExecutionHostLabel() },
        agent: { type: 'codex', model: null, profile: 'Personal' }
      }
    })
  })

  it('omits focusedSurface from readContext unless ui:focus is granted', async () => {
    const { services } = createTerminalHarness(['terminal:local:one'])
    services.readFocusedSurface = vi.fn().mockReturnValue({
      kind: 'terminal',
      title: 'zsh'
    })

    const withoutFocus = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.readContext',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['workspace:read'],
      services
    })
    expect(withoutFocus).toEqual({
      ok: true,
      value: {
        branch: 'main',
        displayName: 'Repo',
        terminals: [{ id: 'terminal:local:one' }]
      }
    })

    const withFocus = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.readContext',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['workspace:read', 'ui:focus'],
      services
    })
    expect(withFocus).toEqual({
      ok: true,
      value: {
        branch: 'main',
        displayName: 'Repo',
        terminals: [{ id: 'terminal:local:one' }],
        focusedSurface: { kind: 'terminal', title: 'zsh' }
      }
    })
    expect(withFocus).not.toHaveProperty('value.worktreeId')
  })

  it('returns the current focused surface from ui.readFocus only with ui:focus', async () => {
    const { services } = createTerminalHarness(['terminal:local:one'])
    services.readFocusedSurface = vi.fn().mockReturnValue({
      kind: 'agent',
      title: 'Claude',
      worktreeId: 'wt-1',
      agentId: 'tab-agent-1'
    })

    const denied = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'ui.readFocus',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['workspace:read'],
      services
    })
    expect(denied).toMatchObject({ ok: false, code: 'capability_denied' })

    const allowed = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'ui.readFocus',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['ui:focus'],
      services
    })
    expect(allowed).toEqual({
      ok: true,
      value: {
        focusedSurface: {
          kind: 'agent',
          title: 'Claude',
          worktreeId: 'wt-1',
          agentId: 'tab-agent-1'
        }
      }
    })
  })

  it('drops ui.focus.changed subscriptions without the ui:focus capability', async () => {
    const subscribeEvents = vi.fn((_: string, events: PluginEventName[]) => events)
    const services = createServices(vi.fn().mockReturnValue({ ok: true }))
    services.subscribeEvents = subscribeEvents

    const denied = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'events.subscribe',
      params: { events: ['ui.focus.changed', 'worktree.created'] },
      viaPanel: false,
      grantedCapabilities: ['events:subscribe'],
      services
    })
    expect(denied).toEqual({ ok: true, value: { subscribed: ['worktree.created'] } })
    expect(subscribeEvents).toHaveBeenCalledWith('orca-samples.demo', ['worktree.created'])

    const allowed = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'events.subscribe',
      params: { events: ['ui.focus.changed'] },
      viaPanel: false,
      grantedCapabilities: ['events:subscribe', 'ui:focus'],
      services
    })
    expect(allowed).toEqual({ ok: true, value: { subscribed: ['ui.focus.changed'] } })
  })
})

describe('terminal.sendText under a refusing agent-session lease', () => {
  it('reports who holds the session instead of an accepted-looking result', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:one'])
    vi.mocked(delegate.sendTerminal).mockRejectedValue(
      new AgentSessionPtyWriteRefusedError({
        code: 'agent_session_conflict',
        sessionId: 'session-alpha-1',
        ownerRuntimeKind: 'native',
        handoffStage: null,
        ownerPid: 4242,
        runtimeFence: 7
      })
    )

    const outcome = await sendTerminalText(services, 'terminal:local:one')

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('session-alpha-1')
    expect(outcome.ok ? '' : outcome.error).toContain('native chat')
  })

  it('sends unchanged when no lease refuses, which is every plugin send today', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:one'])

    const outcome = await sendTerminalText(services, 'terminal:local:one')

    expect(outcome).toEqual({ ok: true, value: { accepted: true } })
    expect(delegate.sendTerminal).toHaveBeenCalledTimes(1)
  })
})

describe('settings.get/set via panel', () => {
  it('reads and writes only the bound plugin settings file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-host-settings-'))
    settingsRoots.push(root)
    const services = createServices(vi.fn())
    services.settings = {
      getAll: (pluginId) => new PluginKvStore(root, pluginId, 'settings.json').getAll(),
      set: (pluginId, key, value) =>
        new PluginKvStore(root, pluginId, 'settings.json').set(key, value)
    }
    new PluginKvStore(root, 'orca-samples.other', 'settings.json').set('secret', 'nope')

    const setOutcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'settings.set',
      params: { key: 'theme', value: 'dark' },
      viaPanel: true,
      grantedCapabilities: ['settings:own'],
      services,
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })
    const getOutcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'settings.get',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['settings:own'],
      services
    })

    expect(setOutcome).toEqual({ ok: true, value: { ok: true } })
    expect(getOutcome).toEqual({ ok: true, value: { settings: { theme: 'dark' } } })
    expect(new PluginKvStore(root, 'orca-samples.demo', 'settings.json').getAll()).toEqual({
      theme: 'dark'
    })
    expect(new PluginKvStore(root, 'orca-samples.other', 'settings.json').getAll()).toEqual({
      secret: 'nope'
    })
  })

  it('refuses a panel result that fits only when the outcome wrapper is ignored', async () => {
    const blob = settingsBlobThatFitsOnlyWithoutOutcomeWrapper()
    const services = createServices(vi.fn())
    services.settings = {
      getAll: () => ({ blob }),
      set: vi.fn().mockReturnValue({ ok: true })
    }

    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'settings.get',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['settings:own'],
      services
    })

    expect(structuredCloneMessageBytes({ settings: { blob } })).toBeLessThanOrEqual(
      PANEL_MESSAGE_MAX_BYTES
    )
    expect(structuredCloneMessageBytes({ ok: true, value: { settings: { blob } } })).toBeGreaterThan(
      PANEL_MESSAGE_MAX_BYTES
    )
    expect(outcome).toEqual({
      ok: false,
      code: 'invalid_request',
      error: 'panel message exceeds the size limit'
    })
  })

  it('denies panel settings without settings:own', async () => {
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'settings.get',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['storage'],
      services: createServices(vi.fn())
    })

    expect(outcome).toMatchObject({ ok: false, code: 'capability_denied' })
  })
})

describe('sidecar host methods', () => {
  it('stores a presence frame and returns host-mediated placement', async () => {
    const mailbox = new PluginSidecarMailbox()
    const { services } = createTerminalHarness(['terminal:local:one'])
    services.sidecar = {
      resolvePlacement: (pluginId) => mailbox.resolvePlacement(pluginId),
      publish: (pluginId, input) => mailbox.publish(pluginId, input)
    }

    const published = await executePluginHostCall({
      pluginId: 'chron0.discord-presence',
      method: 'sidecar.publish',
      params: { channel: 'presence', op: 'set', payload: { details: 'Working in Orca' } },
      viaPanel: false,
      grantedCapabilities: ['sidecar'],
      services,
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(published).toMatchObject({
      ok: true,
      value: {
        accepted: true,
        delivery: 'stored',
        placement: {
          pluginProcess: 'runtime-host',
          discordIpcMustRun: 'machine-with-discord',
          companionStillValid: true
        }
      }
    })

    const placement = await executePluginHostCall({
      pluginId: 'chron0.discord-presence',
      method: 'sidecar.resolvePlacement',
      params: {},
      viaPanel: false,
      grantedCapabilities: ['sidecar'],
      services
    })
    expect(placement).toMatchObject({
      ok: true,
      value: { mailboxAvailable: true, lastPublishedAt: expect.any(Number) }
    })
  })

  it('denies sidecar.publish without the sidecar capability', async () => {
    const outcome = await executePluginHostCall({
      pluginId: 'chron0.discord-presence',
      method: 'sidecar.publish',
      params: { channel: 'presence', op: 'clear' },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices(vi.fn()),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })
    expect(outcome).toMatchObject({ ok: false, code: 'capability_denied' })
  })

  it('forbids sidecar.publish from a sandboxed panel', async () => {
    const outcome = await executePluginHostCall({
      pluginId: 'chron0.discord-presence',
      method: 'sidecar.publish',
      params: { channel: 'presence', op: 'clear' },
      viaPanel: true,
      grantedCapabilities: ['sidecar'],
      services: createServices(vi.fn()),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })
    expect(outcome).toMatchObject({ ok: false, code: 'panel_forbidden' })
  })
})
