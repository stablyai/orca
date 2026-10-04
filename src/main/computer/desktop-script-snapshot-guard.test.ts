import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopScriptSnapshotStore } from './desktop-script-snapshot-store'
import {
  MAX_CACHED_DESKTOP_SNAPSHOT_AGE_MS,
  MAX_CACHED_DESKTOP_SNAPSHOTS
} from './desktop-script-snapshot-cache'
import { DesktopScriptProviderClient } from './desktop-script-provider-client'
import { DesktopScriptRuntimeHost } from './desktop-script-runtime-host'
import { mapBridgeError } from './desktop-script-provider-bridge'
import { sampleBridgeSnapshot, sampleCapabilities } from './desktop-script-provider-test-harness'

const guardedActions = {
  version: 1,
  actions: ['click', 'performSecondaryAction', 'setValue'],
  physicalClick: false,
  guarantee: 'serialized_detected_mismatch',
  humanInputAtomic: false
} as const

describe('exact snapshot guards', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retains the exact prior snapshot independently of the latest alias', () => {
    const store = new DesktopScriptSnapshotStore()
    store.remember(
      'Editor',
      {
        ...sampleBridgeSnapshot('Editor', 'old'),
        coordinateSpace: 'window' as const,
        snapshotId: 'old'
      },
      {}
    )
    store.remember(
      'Editor',
      {
        ...sampleBridgeSnapshot('Editor', 'new'),
        coordinateSpace: 'window' as const,
        snapshotId: 'new'
      },
      {}
    )
    expect(store.exact('old')?.elements?.[0].value).toBe('old')
    expect(store.current('Editor', undefined, {})?.snapshotId).toBe('new')
    expect(store.exact('missing')).toBeNull()
  })

  it('fails closed on expiry, eviction and cache loss', () => {
    vi.useFakeTimers()
    const store = new DesktopScriptSnapshotStore()
    store.remember(
      'Editor',
      {
        ...sampleBridgeSnapshot('Editor', ''),
        coordinateSpace: 'window' as const,
        snapshotId: 'expired'
      },
      {}
    )
    vi.advanceTimersByTime(MAX_CACHED_DESKTOP_SNAPSHOT_AGE_MS + 1)
    expect(store.exact('expired')).toBeNull()
    for (let index = 0; index <= MAX_CACHED_DESKTOP_SNAPSHOTS; index++) {
      store.remember(
        'Editor',
        {
          ...sampleBridgeSnapshot('Editor', ''),
          coordinateSpace: 'window' as const,
          snapshotId: `id-${index}`
        },
        {}
      )
    }
    expect(store.exact('id-0')).toBeNull()
    expect(store.exact(`id-${MAX_CACHED_DESKTOP_SNAPSHOTS}`)).not.toBeNull()
    store.clear()
    expect(store.exact(`id-${MAX_CACHED_DESKTOP_SNAPSHOTS}`)).toBeNull()
  })

  it('binds exact IDs to the originating session or worktree', () => {
    const store = new DesktopScriptSnapshotStore()
    store.remember(
      'Editor',
      {
        ...sampleBridgeSnapshot('Editor', ''),
        coordinateSpace: 'window' as const,
        snapshotId: 'session-owned'
      },
      { session: 'owner' }
    )
    expect(store.exact('session-owned', { session: 'owner' })?.snapshotId).toBe('session-owned')
    expect(store.exact('session-owned', { session: 'foreign' })).toBeNull()
    expect(store.exact('session-owned', { worktree: 'owner' })).toBeNull()
    expect(store.exact('session-owned')).toBeNull()
  })

  it('forwards the exact optional wire field and prior target, without exposing draft metadata', async () => {
    const host = new DesktopScriptRuntimeHost('runtime.ps1')
    const tools: string[] = []
    vi.spyOn(host, 'request').mockImplementation(async (request) => {
      tools.push(request.tool)
      if (request.tool === 'handshake') {
        return {
          ok: true,
          capabilities: {
            ...sampleCapabilities(),
            platform: 'win32' as const,
            guardedActions: { ...guardedActions, actions: [...guardedActions.actions] }
          }
        }
      }
      if (request.tool === 'get_app_state') {
        return {
          ok: true,
          snapshot: {
            ...sampleBridgeSnapshot('Editor', ''),
            coordinateSpace: 'window' as const,
            snapshotId: tools.length === 1 ? 'old' : 'latest'
          }
        }
      }
      expect(request.if_snapshot_id).toBe('old')
      expect(request.element?.runtimeId).toEqual([0, 0])
      return {
        ok: true,
        snapshot: {
          ...sampleBridgeSnapshot('Editor', 'private draft'),
          coordinateSpace: 'window' as const
        },
        action: {
          path: 'accessibility',
          actionName: 'setValue',
          precondition: { state: 'matched', snapshotId: 'old' }
        }
      }
    })
    const client = new DesktopScriptProviderClient('windows', 'runtime.ps1', host)
    await client.snapshot({ app: 'Editor' })
    await client.snapshot({ app: 'Editor' })
    const result = await client.action('setValue', {
      app: 'Editor',
      elementIndex: 0,
      value: 'private draft',
      ifSnapshotId: 'old',
      noScreenshot: true
    })
    expect(result.action?.precondition).toEqual({ state: 'matched', snapshotId: 'old' })
    expect(JSON.stringify(result.action)).not.toContain('private draft')
    expect(JSON.stringify(result)).not.toContain('private')
    expect(result.snapshot.treeText).toBe('')
    expect(result.screenshot).toBeNull()
    expect(tools).toEqual(['get_app_state', 'get_app_state', 'handshake', 'set_value'])
    client.shutdown()
  })

  it.each(['missing', 'truncated'])('refuses %s guards without sending an action', async (kind) => {
    const host = new DesktopScriptRuntimeHost('runtime.ps1')
    const tools: string[] = []
    vi.spyOn(host, 'request').mockImplementation(async (request) => {
      tools.push(request.tool)
      return request.tool === 'handshake'
        ? {
            ok: true,
            capabilities: {
              ...sampleCapabilities(),
              platform: 'win32' as const,
              guardedActions: { ...guardedActions, actions: [...guardedActions.actions] }
            }
          }
        : {
            ok: true,
            snapshot: {
              ...sampleBridgeSnapshot('Editor', ''),
              coordinateSpace: 'window' as const,
              truncation: { truncated: true }
            }
          }
    })
    const client = new DesktopScriptProviderClient('windows', 'runtime.ps1', host)
    if (kind === 'truncated') {
      await client.snapshot({ app: 'Editor' })
    }
    await expect(
      client.action('click', { app: 'Editor', elementIndex: 0, ifSnapshotId: 'snap-test' })
    ).rejects.toMatchObject({ code: 'precondition_failed' })
    expect(tools).not.toContain('click')
    client.shutdown()
  })

  it('rejects an old provider before sending guarded input', async () => {
    const host = new DesktopScriptRuntimeHost('runtime.ps1')
    const tools: string[] = []
    vi.spyOn(host, 'request').mockImplementation(async (request) => {
      tools.push(request.tool)
      return { ok: true, capabilities: { ...sampleCapabilities(), platform: 'win32' as const } }
    })
    const client = new DesktopScriptProviderClient('windows', 'runtime.ps1', host)
    await expect(
      client.action('click', { app: 'Editor', elementIndex: 0, ifSnapshotId: 'id' })
    ).rejects.toMatchObject({ code: 'unsupported_capability' })
    expect(tools).toEqual(['handshake'])
    client.shutdown()
  })

  it('never leaks provider precondition text', () => {
    const error = mapBridgeError('precondition_failed private document private draft target label')
    expect(error.code).toBe('precondition_failed')
    expect(error.message).toBe('Snapshot precondition did not match')
  })
})
