import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { getDefaultSettings } from '../shared/constants'
import { createPortableSettingsBundle } from '../shared/portable-settings'
import type { RuntimeRpcResponse } from '../shared/runtime-rpc-envelope'
import type { GlobalSettings } from '../shared/types'
import { PortableSettingsSyncService } from './portable-settings-sync-service'

function success(result: unknown) {
  return {
    id: 'request',
    ok: true as const,
    result,
    _meta: { runtimeId: 'remote-runtime' }
  }
}

describe('PortableSettingsSyncService', () => {
  let dir: string
  let settings: GlobalSettings
  let settingsListener: (() => void) | null
  let keybindingListener: (() => void) | null
  let callEnvironment: Mock<
    (
      environmentId: string,
      method: string,
      params: unknown,
      timeoutMs: number
    ) => Promise<RuntimeRpcResponse<unknown>>
  >

  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'orca-settings-sync-'))
    settings = getDefaultSettings('/home/local')
    settingsListener = null
    keybindingListener = null
    const remoteBundle = createPortableSettingsBundle(getDefaultSettings('/home/remote'), {
      platform: 'linux',
      overrides: {}
    })
    callEnvironment = vi.fn(async (_environmentId, method) =>
      method === 'settings.portable.get'
        ? success({ bundle: remoteBundle })
        : success({ bundle: remoteBundle, appliedCategories: ['appearance'] })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function createService(): PortableSettingsSyncService {
    return new PortableSettingsSyncService({
      configPath: join(dir, 'sync.json'),
      store: {
        getSettings: () => settings,
        onSettingsChanged: (listener) => {
          settingsListener = () => listener({}, settings)
          return () => {
            settingsListener = null
          }
        }
      } as never,
      keybindings: {
        getSnapshot: () => ({
          platform: 'linux',
          overrides: {},
          path: join(dir, 'keybindings.json'),
          exists: false,
          commonOverrides: {},
          platformOverrides: {},
          diagnostics: []
        }),
        onChanged: (listener) => {
          keybindingListener = () => listener({} as never)
          return () => {
            keybindingListener = null
          }
        }
      } as never,
      callEnvironment,
      environmentExists: () => true,
      now: () => 1234
    })
  }

  it('persists a rule and performs the initial remote sync', async () => {
    settings = { ...settings, theme: 'dark' }
    const service = createService()
    service.start()

    const state = await service.configure({
      environmentId: 'server-1',
      categories: ['appearance'],
      enabled: true
    })

    expect(callEnvironment.mock.calls.map((call) => call[1])).toEqual([
      'settings.portable.get',
      'settings.portable.apply'
    ])
    expect(state).toMatchObject({
      environmentId: 'server-1',
      categories: ['appearance'],
      enabled: true,
      phase: 'synced',
      lastSyncedAt: 1234
    })
    expect(JSON.parse(readFileSync(join(dir, 'sync.json'), 'utf8'))).toMatchObject({
      version: 1,
      rules: [{ environmentId: 'server-1', enabled: true }]
    })
    service.dispose()
  })

  it('coalesces local changes and sends only the latest bundle', async () => {
    const service = createService()
    service.start()
    await service.configure({
      environmentId: 'server-1',
      categories: ['appearance'],
      enabled: true
    })
    callEnvironment.mockClear()

    settings = { ...settings, theme: 'dark' }
    settingsListener?.()
    settingsListener?.()
    await vi.advanceTimersByTimeAsync(999)
    expect(callEnvironment).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(callEnvironment).toHaveBeenCalledOnce())

    expect(callEnvironment).toHaveBeenCalledWith(
      'server-1',
      'settings.portable.apply',
      expect.objectContaining({
        categories: ['appearance'],
        bundle: expect.objectContaining({
          categories: expect.objectContaining({
            appearance: expect.objectContaining({ theme: 'dark' })
          })
        })
      }),
      15_000
    )
    service.dispose()
  })

  it('retries after an offline failure and keeps the rule marked with the error', async () => {
    callEnvironment.mockRejectedValueOnce(new Error('server offline'))
    const service = createService()
    service.start()

    await expect(
      service.configure({
        environmentId: 'server-1',
        categories: ['appearance'],
        enabled: true
      })
    ).rejects.toThrow('server offline')
    expect(service.getState('server-1')).toMatchObject({
      phase: 'error',
      lastError: 'server offline'
    })

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(service.getState('server-1')?.phase).toBe('synced'))
    service.dispose()
  })

  it('does not mutate in-memory rules when persistence fails', async () => {
    const service = createService()
    service.start()
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'not a directory', 'utf8')

    await expect(
      service.configure({
        environmentId: 'server-1',
        categories: ['appearance'],
        enabled: true
      })
    ).rejects.toThrow()
    expect(service.getState('server-1')).toBeNull()
    expect(callEnvironment).not.toHaveBeenCalled()
    service.dispose()
  })

  it('does not schedule a retry after disposal', async () => {
    let rejectRequest: (error: Error) => void = () => undefined
    callEnvironment.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject
        })
    )
    const service = createService()
    service.start()
    const configure = service.configure({
      environmentId: 'server-1',
      categories: ['appearance'],
      enabled: true
    })
    await vi.waitFor(() => expect(callEnvironment).toHaveBeenCalledOnce())

    service.dispose()
    rejectRequest(new Error('late offline failure'))
    await expect(configure).rejects.toThrow('late offline failure')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(callEnvironment).toHaveBeenCalledOnce()
  })

  it('suppresses outbound work while applying an inbound settings bundle', async () => {
    const service = createService()
    service.start()
    await service.configure({
      environmentId: 'server-1',
      categories: ['input'],
      enabled: true
    })
    callEnvironment.mockClear()

    service.runWithoutOutboundSync(() => {
      settingsListener?.()
      keybindingListener?.()
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(callEnvironment).not.toHaveBeenCalled()
    service.dispose()
  })

  it('keeps outbound suppression active until asynchronous inbound work settles', async () => {
    const service = createService()
    service.start()
    await service.configure({
      environmentId: 'server-1',
      categories: ['input'],
      enabled: true
    })
    callEnvironment.mockClear()
    let finishInbound: () => void = () => undefined
    const inboundWait = new Promise<void>((resolve) => {
      finishInbound = resolve
    })

    const guarded = service.runWithoutOutboundSync(async () => {
      await inboundWait
      settingsListener?.()
      keybindingListener?.()
    })
    finishInbound()
    await guarded
    await vi.advanceTimersByTimeAsync(2_000)

    expect(callEnvironment).not.toHaveBeenCalled()
    service.dispose()
  })
})
