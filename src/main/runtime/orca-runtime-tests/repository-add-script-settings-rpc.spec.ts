import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isRecord } from '../../../shared/agent-status-child-work-value-guards'
import type { RpcRequest } from '../rpc/core'
import { RpcDispatcher } from '../rpc/dispatcher'
import { CLIENT_UI_METHODS } from '../rpc/methods/client-ui'

const SCRIPT = '#!/bin/sh\n  echo hi \n'

function setup(initial: Partial<GlobalSettings> = { repositoryAddScript: SCRIPT }) {
  let settings: GlobalSettings = {
    ...createGlobalSettingsFixture({ workspaceDir: '/w' }),
    ...initial
  }
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    settings = { ...settings, ...updates }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths touch only getSettings/updateSettings on the store.
  const runtime = new OrcaRuntimeService({
    ...store,
    getSettings: () => settings,
    updateSettings
  } as never)
  const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
  const call = async (method: string, params?: unknown) => {
    const request: RpcRequest = { id: 'req-1', authToken: 'tok', method, params }
    const response = await dispatcher.dispatch(request)
    if (!response.ok) {
      return { ok: false as const, error: response.error }
    }
    const { result } = response
    const settingsResult = isRecord(result) && isRecord(result.settings) ? result.settings : {}
    return { ok: true as const, result: { settings: settingsResult } }
  }
  return { call, updateSettings, current: () => settings }
}

describe('repository add script over settings.get / settings.update', () => {
  it.each([undefined, null, {}, { includeRepositoryAddScript: false }])(
    'omits the script from settings.get params %j',
    async (params) => {
      const { call } = setup()
      const response = await call('settings.get', params)
      expect(response.ok).toBe(true)
      expect(response.result?.settings).not.toHaveProperty('repositoryAddScript')
    }
  )

  it('returns the exact script only for strict true', async () => {
    const { call } = setup()
    const response = await call('settings.get', { includeRepositoryAddScript: true })
    expect(response.result?.settings.repositoryAddScript).toBe(SCRIPT)
  })

  it('tolerates unknown params from older clients on settings.get', async () => {
    const { call } = setup()
    expect((await call('settings.get', { somethingNew: 1 })).ok).toBe(true)
  })

  it.each([{ includeRepositoryAddScript: 'true' }, { includeRepositoryAddScript: 1 }])(
    'rejects non-boolean settings.get flag %j',
    async (params) => {
      const response = await setup().call('settings.get', params)
      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
  )

  it('rejects a non-boolean flag on settings.update without writing', async () => {
    const { call, updateSettings } = setup()
    const response = await call('settings.update', { includeRepositoryAddScript: 'yes' })
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('does not leak the script from an unrelated settings.update', async () => {
    const { call } = setup()
    const response = await call('settings.update', { machineName: 'box' })
    expect(response.ok).toBe(true)
    expect(response.result?.settings).not.toHaveProperty('repositoryAddScript')
  })

  it('does not leak the script from updatePRBotAuthorOverride', async () => {
    const { call } = setup()
    const response = await call('settings.updatePRBotAuthorOverride', {
      author: 'some-bot',
      isBot: true
    })
    expect(response.ok).toBe(true)
    expect(response.result?.settings).not.toHaveProperty('repositoryAddScript')
  })

  it('writes the script and echoes it exactly when opted in, never persisting the flag', async () => {
    const { call, updateSettings, current } = setup({})
    const next = '  echo new\n'
    const response = await call('settings.update', {
      repositoryAddScript: next,
      includeRepositoryAddScript: true
    })
    expect(response.result?.settings.repositoryAddScript).toBe(next)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    const [updates] = updateSettings.mock.calls[0]!
    expect(updates).toMatchObject({ repositoryAddScript: next })
    expect(updates).not.toHaveProperty('includeRepositoryAddScript')
    expect(current()).not.toHaveProperty('includeRepositoryAddScript')
  })

  it('writes the script without echoing it when not opted in', async () => {
    const { call, current } = setup({})
    const response = await call('settings.update', { repositoryAddScript: 'echo x' })
    expect(current().repositoryAddScript).toBe('echo x')
    expect(response.result?.settings).not.toHaveProperty('repositoryAddScript')
  })

  it('echoes an opted-in update to an unrelated field with the existing script', async () => {
    const { call } = setup()
    const response = await call('settings.update', {
      machineName: 'box',
      includeRepositoryAddScript: true
    })
    expect(response.result?.settings.repositoryAddScript).toBe(SCRIPT)
  })

  it('leaves an older client that merges whole responses without the script', async () => {
    const { call } = setup()
    const local: Record<string, unknown> = { machineName: 'old' }
    for (const response of [
      await call('settings.get'),
      await call('settings.update', { machineName: 'box' })
    ]) {
      Object.assign(local, response.result?.settings)
    }
    expect(local).not.toHaveProperty('repositoryAddScript')
  })
})
