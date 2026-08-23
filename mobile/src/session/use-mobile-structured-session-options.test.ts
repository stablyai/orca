import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOptionResult } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'
import { useMobileStructuredSessionOptions } from './use-mobile-structured-session-options'

describe('useMobileStructuredSessionOptions', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: MobileNativeChatSessionOptionsController | null = null
  let sessionId = 'mobile_1'
  let fence = 3
  const setOption =
    vi.fn<(key: string, value: string) => Promise<AgentSessionOptionResult | null>>()
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client = { sendRequest } as RpcClient

  function Probe(): null {
    controller = useMobileStructuredSessionOptions({
      client,
      connected: true,
      sessionId,
      fence,
      setOption
    })
    return null
  }

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setOption.mockReset().mockImplementation(async (key, value) => ({ key, value }))
    sendRequest.mockReset().mockResolvedValue({
      id: 'options',
      ok: true,
      result: {
        models: [
          {
            id: 'account-only',
            label: 'Account Only',
            isDefault: true,
            defaultEffort: 'medium',
            efforts: [
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' }
            ]
          },
          {
            id: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol Live',
            isDefault: false,
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' }
            ]
          },
          {
            id: 'gpt-5.6-terra',
            label: 'GPT-5.6 Terra Live',
            isDefault: false,
            efforts: [
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' }
            ]
          }
        ],
        current: { model: 'account-only', effort: 'medium' }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    sessionId = 'mobile_1'
    fence = 3
    await act(async () => {
      renderer = create(createElement(Probe))
      await Promise.resolve()
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
  })

  it('uses provider-scoped models and hydrates current model and effort', () => {
    expect(sendRequest).toHaveBeenCalledWith('agentSession.options', { sessionId: 'mobile_1' })
    const model = controller!.snapshot.find((entry) => entry.id === 'model')
    expect(model?.kind).toEqual({
      type: 'select',
      currentValue: 'account-only',
      choices: [
        { value: 'account-only', label: 'Account Only' },
        { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol Live' },
        { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra Live' }
      ]
    })
    expect(model).not.toHaveProperty('action')
    expect(controller!.snapshot.find((entry) => entry.id === 'effort')).toMatchObject({
      kind: { currentValue: 'medium' },
      valueSource: 'reported'
    })
  })

  it('uses agentSession.setOption and tracks the applied model and effort', async () => {
    setOption.mockResolvedValueOnce({
      key: 'model',
      value: 'gpt-5.6-sol',
      options: { model: 'gpt-5.6-sol', effort: 'low' }
    })
    await act(async () => {
      await controller!.setOption('model', 'gpt-5.6-sol')
    })
    expect(controller!.snapshot.find((entry) => entry.id === 'effort')?.kind).toMatchObject({
      currentValue: 'low'
    })
    await act(async () => {
      await controller!.setOption('effort', 'high')
    })

    expect(setOption).toHaveBeenNthCalledWith(1, 'model', 'gpt-5.6-sol')
    expect(setOption).toHaveBeenNthCalledWith(2, 'effort', 'high')
    expect(controller!.snapshot.find((entry) => entry.id === 'model')?.kind).toMatchObject({
      currentValue: 'gpt-5.6-sol'
    })
    expect(controller!.snapshot.find((entry) => entry.id === 'effort')?.kind).toMatchObject({
      currentValue: 'high'
    })
  })

  it('opens the real model and effort pickers for structured actions', async () => {
    await act(async () => {
      expect(await controller!.invokeAction('model')).toBe(true)
    })
    expect(controller!.pickerRequest?.id).toBe('model')
    await act(async () => {
      controller!.dismissPickerRequest?.(controller!.pickerRequest!.token)
      expect(await controller!.invokeAction('effort')).toBe(true)
    })
    expect(controller!.pickerRequest?.id).toBe('effort')
  })

  it('rejects values absent from the live provider catalog', async () => {
    await act(async () => {
      expect(await controller!.setOption('model', 'static-only-model')).toBe(false)
    })
    expect(setOption).not.toHaveBeenCalled()
  })

  it('does not claim a rejected option was applied', async () => {
    setOption.mockResolvedValue(null)
    await act(async () => {
      await controller!.setOption('model', 'gpt-5.6-terra')
    })

    expect(controller!.snapshot.find((entry) => entry.id === 'model')).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'account-only' }
    })
    expect(controller!.pendingId).toBeNull()
  })

  it('does not apply an in-flight option result to a replacement session', async () => {
    let resolve!: (result: AgentSessionOptionResult) => void
    setOption.mockReturnValueOnce(new Promise<AgentSessionOptionResult>((done) => (resolve = done)))
    let oldResult!: boolean
    let pending!: Promise<boolean>
    act(() => {
      pending = controller!.setOption('model', 'gpt-5.6-sol')
    })
    sessionId = 'mobile_2'
    await act(async () => {
      renderer!.update(createElement(Probe))
      await Promise.resolve()
    })
    await act(async () => {
      resolve({ key: 'model', value: 'gpt-5.6-sol' })
      oldResult = await pending
    })

    expect(oldResult).toBe(false)
    expect(controller!.pendingId).toBeNull()
    expect(controller!.snapshot.find((entry) => entry.id === 'model')).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'account-only' }
    })
  })

  it('rehydrates the provider catalog when the runtime fence changes', async () => {
    sendRequest.mockResolvedValueOnce({
      id: 'options-after-takeover',
      ok: true,
      result: {
        models: [
          {
            id: 'resumed-model',
            label: 'Resumed Model',
            isDefault: true,
            defaultEffort: 'high',
            efforts: [{ value: 'high', label: 'High' }]
          }
        ],
        current: { model: 'resumed-model', effort: 'high' }
      },
      _meta: { runtimeId: 'runtime-2' }
    })
    fence = 4

    await act(async () => {
      renderer!.update(createElement(Probe))
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenLastCalledWith('agentSession.options', {
      sessionId: 'mobile_1'
    })
    expect(controller!.snapshot.find((entry) => entry.id === 'model')?.kind).toMatchObject({
      currentValue: 'resumed-model',
      choices: [{ value: 'resumed-model', label: 'Resumed Model' }]
    })
  })
})
