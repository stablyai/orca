import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import {
  downloadDictationModel,
  fetchDictationSetup,
  isDictationReady,
  isDictationSetupRequiredError,
  isModelInFlight,
  setDictationConfig,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from './mobile-dictation-setup'

function ok(result: unknown): RpcSuccess {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt' } }
}
function fail(message: string): RpcFailure {
  return { id: 'r', ok: false, error: { code: 'x', message }, _meta: { runtimeId: 'rt' } }
}
function clientWith(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
  calls: Array<{ method: string; params: unknown }>
} {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      return responses.shift() ?? fail('unexpected')
    })
  }
}

function model(overrides: Partial<MobileSpeechModel> = {}): MobileSpeechModel {
  return {
    id: 'm1',
    label: 'M1',
    provider: 'local',
    sizeBytes: 100,
    recommended: true,
    status: 'not-downloaded',
    progress: null,
    ...overrides
  }
}

describe('isDictationSetupRequiredError', () => {
  it('matches the setup-required error codes', () => {
    expect(isDictationSetupRequiredError('voice_dictation_disabled')).toBe(true)
    expect(isDictationSetupRequiredError('voice_model_not_selected')).toBe(true)
    expect(isDictationSetupRequiredError('voice_model_not_ready:not-downloaded')).toBe(true)
    expect(isDictationSetupRequiredError('dictation_already_active')).toBe(false)
    expect(isDictationSetupRequiredError('network down')).toBe(false)
  })
})

describe('rpc wrappers', () => {
  it('fetches setup', async () => {
    const setup: MobileSpeechSetup = { enabled: false, selectedModelId: '', models: [] }
    const client = clientWith([ok(setup)])
    await expect(fetchDictationSetup(client)).resolves.toEqual(setup)
    expect(client.calls[0]).toEqual({ method: 'speech.models.list', params: null })
  })

  it('starts a download', async () => {
    const client = clientWith([ok({ started: true })])
    await downloadDictationModel(client, 'm1')
    expect(client.calls[0]).toEqual({ method: 'speech.models.download', params: { modelId: 'm1' } })
  })

  it('sets config', async () => {
    const setup: MobileSpeechSetup = { enabled: true, selectedModelId: 'm1', models: [] }
    const client = clientWith([ok(setup)])
    await expect(setDictationConfig(client, { enabled: true, modelId: 'm1' })).resolves.toEqual(
      setup
    )
    expect(client.calls[0]).toEqual({
      method: 'speech.dictation.setup',
      params: { enabled: true, modelId: 'm1' }
    })
  })

  it('surfaces RPC failures as errors', async () => {
    const client = clientWith([fail('disconnected')])
    await expect(fetchDictationSetup(client)).rejects.toThrow('disconnected')
  })
})

describe('state helpers', () => {
  it('isModelInFlight covers downloading + extracting', () => {
    expect(isModelInFlight(model({ status: 'downloading' }))).toBe(true)
    expect(isModelInFlight(model({ status: 'extracting' }))).toBe(true)
    expect(isModelInFlight(model({ status: 'ready' }))).toBe(false)
  })

  it('isDictationReady requires enabled + selected + ready', () => {
    expect(
      isDictationReady({
        enabled: true,
        selectedModelId: 'm1',
        models: [model({ status: 'ready' })]
      })
    ).toBe(true)
    expect(
      isDictationReady({
        enabled: false,
        selectedModelId: 'm1',
        models: [model({ status: 'ready' })]
      })
    ).toBe(false)
    expect(
      isDictationReady({
        enabled: true,
        selectedModelId: 'm1',
        models: [model({ status: 'not-downloaded' })]
      })
    ).toBe(false)
    expect(isDictationReady({ enabled: true, selectedModelId: '', models: [] })).toBe(false)
  })
})
