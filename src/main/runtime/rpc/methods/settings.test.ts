import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { SETTINGS_METHODS } from './settings'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntime(overrides: Partial<GlobalSettings> = {}): {
  runtime: OrcaRuntimeService
  getSettings: () => GlobalSettings
} {
  let settings: GlobalSettings = {
    ...getDefaultSettings('/tmp/orca-home'),
    ...overrides
  }
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = {
        ...settings,
        ...updates
      }
      return settings
    }
  }
  return {
    runtime: new OrcaRuntimeService(store as never),
    getSettings: () => settings
  }
}

describe('settings RPC methods', () => {
  it('gets and sets browser permission settings with key-specific validation', async () => {
    const { runtime, getSettings } = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SETTINGS_METHODS })

    await expect(
      dispatcher.dispatch(
        makeRequest('settings.set', { key: 'browserInteractionMode', value: 'human' })
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { key: 'browserInteractionMode', value: 'human' }
    })
    expect(getSettings().browserInteractionMode).toBe('human')

    await expect(
      dispatcher.dispatch(
        makeRequest('settings.set', {
          key: 'browserPermissionNoticePolicy',
          value: 'silent-auto-deny'
        })
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { key: 'browserPermissionNoticePolicy', value: 'silent-auto-deny' }
    })

    await expect(
      dispatcher.dispatch(
        makeRequest('settings.set', { key: 'browserInteractionMode', value: 'silent-auto-deny' })
      )
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Invalid browserInteractionMode: expected agent or human'
      }
    })
    expect(getSettings().browserInteractionMode).toBe('human')
  })

  it('normalizes site-rule origins and updates duplicates instead of appending', async () => {
    const { runtime, getSettings } = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SETTINGS_METHODS })

    await dispatcher.dispatch(
      makeRequest('browserPermissions.set', {
        profileId: 'profile-1',
        origin: 'https://Example.com:443/path',
        permission: 'notifications',
        action: 'allow'
      })
    )
    await dispatcher.dispatch(
      makeRequest('browserPermissions.set', {
        profileId: 'profile-1',
        origin: 'https://example.com/other',
        permission: 'notifications',
        action: 'deny'
      })
    )
    const promptResponse = await dispatcher.dispatch(
      makeRequest('browserPermissions.set', {
        profileId: 'profile-1',
        origin: 'https://example.com/final',
        permission: 'notifications',
        action: 'prompt'
      })
    )

    expect(promptResponse).toMatchObject({
      ok: true,
      result: {
        profileId: 'profile-1',
        origin: 'https://example.com',
        permission: 'notifications',
        action: 'prompt'
      }
    })
    expect(getSettings().browserSitePermissionRules).toEqual([
      {
        profileId: 'profile-1',
        origin: 'https://example.com',
        permission: 'notifications',
        action: 'prompt'
      }
    ])
  })

  it('rejects invalid origins and unsupported permission names before persistence', async () => {
    const { runtime, getSettings } = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SETTINGS_METHODS })

    await expect(
      dispatcher.dispatch(
        makeRequest('browserPermissions.set', {
          origin: 'file:///tmp/index.html',
          permission: 'notifications',
          action: 'allow'
        })
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: 'Invalid --origin: expected an http(s) URL' }
    })

    await expect(
      dispatcher.dispatch(
        makeRequest('browserPermissions.set', {
          origin: 'https://example.com',
          permission: 'serial',
          action: 'allow'
        })
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })

    expect(getSettings().browserSitePermissionRules).toEqual([])
  })

  it('keeps remembered rules scoped by browser profile and removes idempotently', async () => {
    const { runtime, getSettings } = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SETTINGS_METHODS })

    await dispatcher.dispatch(
      makeRequest('browserPermissions.set', {
        profileId: 'profile-1',
        origin: 'https://example.com',
        permission: 'media',
        action: 'allow'
      })
    )
    await dispatcher.dispatch(
      makeRequest('browserPermissions.set', {
        profileId: 'profile-2',
        origin: 'https://example.com',
        permission: 'media',
        action: 'deny'
      })
    )

    await expect(
      dispatcher.dispatch(makeRequest('browserPermissions.list', { profileId: 'profile-1' }))
    ).resolves.toMatchObject({
      ok: true,
      result: {
        rules: [
          {
            profileId: 'profile-1',
            origin: 'https://example.com',
            permission: 'media',
            action: 'allow'
          }
        ]
      }
    })

    await dispatcher.dispatch(
      makeRequest('browserPermissions.remove', {
        profileId: 'profile-1',
        origin: 'https://example.com/page',
        permission: 'media'
      })
    )
    await dispatcher.dispatch(
      makeRequest('browserPermissions.remove', {
        profileId: 'profile-1',
        origin: 'https://example.com/page',
        permission: 'media'
      })
    )

    expect(getSettings().browserSitePermissionRules).toEqual([
      {
        profileId: 'profile-2',
        origin: 'https://example.com',
        permission: 'media',
        action: 'deny'
      }
    ])
  })
})
