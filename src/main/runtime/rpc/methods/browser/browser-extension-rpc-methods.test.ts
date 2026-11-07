import { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ExtensionList,
  ExtensionReload
} from '../../../../../shared/rpc-contract/browser-extension-params'
import {
  getRuntimeBrowserExtensions,
  setRuntimeBrowserCommandsFactory
} from '../../../browser/installation/runtime-browser-commands-factory'
import type { RuntimeBrowserCommandsFactory } from '../../../browser/installation/runtime-browser-commands-factory'
import { BROWSER_EXTENSION_METHODS } from './browser-extension-rpc-methods'
import { denyRpcMethodForCaller } from '../../rpc-caller-scope'
import { isDesktopBrowserBridgeMethod } from '../../../../../shared/desktop-browser-bridge-protocol'

const factory = vi.fn<RuntimeBrowserCommandsFactory>()
afterEach(() => setRuntimeBrowserCommandsFactory(null))

describe('extension RPC admission', () => {
  it.each([{}, { headless: true }, { isAvailable: () => false }])(
    'rejects unavailable and headless providers',
    (options) => {
      setRuntimeBrowserCommandsFactory(factory, options)
      expect(() => getRuntimeBrowserExtensions()).toThrow(
        expect.objectContaining({ code: 'browser_unavailable' })
      )
    }
  )

  it('rejects a runtime without any browser provider', () => {
    setRuntimeBrowserCommandsFactory(null)
    expect(() => getRuntimeBrowserExtensions()).toThrow(
      expect.objectContaining({ code: 'browser_unavailable' })
    )
  })

  it('does not grant extension access to a headless provider even if injected', () => {
    setRuntimeBrowserCommandsFactory(factory, {
      headless: true,
      extensions: { list: vi.fn(), reload: vi.fn() }
    })
    expect(() => getRuntimeBrowserExtensions()).toThrow(
      expect.objectContaining({ code: 'browser_unavailable' })
    )
  })

  it('dispatches authorized desktop requests and rejects invalid wire input and mobile calls', async () => {
    const dispatcher = new RpcDispatcher({ runtime: new OrcaRuntimeService() })
    const list = vi.fn(async () => ({ active: true, extensions: [] }))
    const reload = vi.fn(async () => ({
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      scope: 'enabled-profiles' as const
    }))
    setRuntimeBrowserCommandsFactory(factory, { extensions: { list, reload } })
    const request = (method: string, params: unknown) => ({
      id: 'extensions',
      authToken: 'unused',
      method,
      params
    })
    await expect(
      dispatcher.dispatch(request('browser.extensionList', { profileId: 'work' }))
    ).resolves.toMatchObject({ ok: true, result: { active: true, extensions: [] } })
    expect(list).toHaveBeenCalledWith({ profileId: 'work' })
    await expect(
      dispatcher.dispatch(request('browser.extensionReload', { path: '/source' }))
    ).resolves.toMatchObject({
      ok: true,
      result: { extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', scope: 'enabled-profiles' }
    })
    expect(reload).toHaveBeenCalledWith({ path: '/source' })
    reload.mockClear()
    await expect(
      dispatcher.dispatch(request('browser.extensionReload', { extensionId: 'bad' }))
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    await expect(
      dispatcher.dispatch(request('browser.extensionReload', { path: '/source' }), {
        callerScope: { kind: 'mobile' }
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(reload).not.toHaveBeenCalled()
    setRuntimeBrowserCommandsFactory(null)
    await expect(dispatcher.dispatch(request('browser.extensionList', {}))).resolves.toMatchObject({
      ok: false,
      error: { code: 'browser_unavailable' }
    })
  })

  it('validates wire selections and does not forward management to an SSH desktop', () => {
    expect(ExtensionList.safeParse({ profileId: '' }).success).toBe(false)
    for (const params of [
      {},
      { extensionId: 'invalid' },
      { path: '' },
      { extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', path: '/source' }
    ]) {
      expect(ExtensionReload.safeParse(params).success).toBe(false)
    }
    expect(ExtensionReload.parse({ path: '/source', profileId: 'work' })).toEqual({
      path: '/source',
      profileId: 'work'
    })
    for (const method of BROWSER_EXTENSION_METHODS) {
      expect(
        denyRpcMethodForCaller({ kind: 'mobile' }, method.name, method.permission)
      ).not.toBeNull()
      expect(isDesktopBrowserBridgeMethod(method.name)).toBe(false)
    }
  })
})
