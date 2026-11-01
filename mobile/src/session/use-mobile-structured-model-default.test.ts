import type { AgentSessionOptionResult } from '../../../src/shared/agent-session/options/agent-session-options-result'
import { act } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'

import type { PersistedNativeChatSessionOptions } from '../../../src/shared/native-chat/input/native-chat-session-options'
import type { StructuredAgentSessionMutationResult } from './mobile-structured-agent-session-rpc'
import {
  accepted,
  BASE,
  currentValueOf,
  deferred,
  descriptorFor,
  mountOptions,
  optionsClient,
  recordingMutate
} from './use-mobile-structured-agent-options.test-fixture'
import {
  applyNativeChatSessionOptionSettingsMutation,
  resolveStructuredLaunchSeedOptions
} from '../../../src/shared/native-chat/input/native-chat-session-option-defaults'
import { NativeChatSessionOptionsMutation } from '../../../src/shared/rpc-contract/client-settings-params'

import { OPTIONS } from './mobile-structured-agent-option-test-data'

describe('useMobileStructuredAgentOptions Default model', () => {
  it.each([false, true])(
    'serializes Default reset with dependent option writes (reset first: %s)',
    async (resetFirst) => {
      let reads = 0
      const client = optionsClient(() =>
        ++reads === 1 ? Promise.resolve(OPTIONS) : new Promise(() => {})
      )
      const inFlight = deferred<StructuredAgentSessionMutationResult<AgentSessionOptionResult>>()
      const mutation = recordingMutate(() => inFlight.promise)
      const mounted = await mountOptions({
        ...BASE,
        client: client.client,
        mutate: mutation.mutate,
        supportsDefault: true
      })
      let first: Promise<unknown> | undefined
      await act(async () => {
        first = resetFirst
          ? mounted.current().optionSurface.resetOption?.('model')
          : mounted.current().setStructuredOption('effort', 'medium')
        if (resetFirst) {
          expect(await mounted.current().setStructuredOption('effort', 'medium')).toBe(false)
          expect(mounted.current().isModelWritePending()).toBe(true)
        } else {
          await mounted.current().optionSurface.resetOption?.('model')
        }
      })
      expect(mutation.calls).toHaveLength(1)
      expect(mutation.calls[0]?.fields).toEqual(
        resetFirst ? { key: 'model', value: null } : { key: 'effort', value: 'medium' }
      )
      await act(async () => {
        inFlight.resolve(
          accepted(
            resetFirst
              ? {
                  key: 'model',
                  value: null,
                  modelDefault: true,
                  options: { model: 'gpt-fast', effort: 'low' }
                }
              : { key: 'effort', value: 'medium', options: { effort: 'medium' } },
            true
          )
        )
        await first
      })
      expect(mounted.current().pendingOptionId).toBeNull()
      expect(mounted.current().isModelWritePending()).toBe(false)
      expect(currentValueOf(mounted.current().optionSnapshot, 'effort')).toBe(
        resetFirst ? 'low' : 'medium'
      )
      await mounted.unmount()
    }
  )
  it.each([false, true])(
    'keeps Default across effort-only persistence until an explicit model pick (full reply: %s)',
    async (fullReply) => {
      let persisted: PersistedNativeChatSessionOptions = {
        codex: { model: 'gpt-live', valuesByModel: {} }
      }
      let reads = 0
      const client = optionsClient(() =>
        ++reads === 1 ? Promise.resolve(OPTIONS) : new Promise(() => {})
      )
      const request = client.client.sendRequest
      client.client.sendRequest = async (method, params) => {
        if (method === 'settings.mutateNativeChatSessionOptions') {
          persisted =
            applyNativeChatSessionOptionSettingsMutation(
              persisted,
              NativeChatSessionOptionsMutation.parse(params)
            ) ?? persisted
        }
        return request(method, params)
      }
      const mutation = recordingMutate(async (call) =>
        accepted(
          call === 0
            ? {
                key: 'model',
                value: null,
                modelDefault: true,
                options: { model: 'gpt-fast', effort: 'low' }
              }
            : {
                key: call === 3 ? 'model' : 'effort',
                value: call === 3 ? 'gpt-fast' : call === 1 ? 'medium' : 'low',
                options: {
                  ...(fullReply || call === 3 ? { model: 'gpt-fast' } : {}),
                  effort: call === 2 ? 'low' : 'medium'
                }
              },
          true
        )
      )
      const mounted = await mountOptions({
        ...BASE,
        client: client.client,
        mutate: mutation.mutate,
        supportsDefault: true
      })
      await act(async () => {
        await mounted.current().optionSurface.resetOption?.('model')
      })
      expect(resolveStructuredLaunchSeedOptions(persisted, 'codex')).toBeUndefined()
      for (const effort of ['medium', 'low']) {
        await act(async () => {
          expect(await mounted.current().setStructuredOption('effort', effort)).toBe(true)
        })
        expect(persisted.codex?.valuesByModel?.['gpt-fast']?.effort).toBe(effort)
        expect(resolveStructuredLaunchSeedOptions(persisted, 'codex')).toBeUndefined()
        expect(
          descriptorFor(mounted.current().optionSnapshot, 'model')?.defaultChoice?.selected
        ).toBe(true)
      }
      await act(async () => {
        expect(await mounted.current().setStructuredOption('model', 'gpt-fast')).toBe(true)
      })
      expect(resolveStructuredLaunchSeedOptions(persisted, 'codex')).toEqual({
        model: 'gpt-fast',
        effort: 'low'
      })
      expect(
        descriptorFor(mounted.current().optionSnapshot, 'model')?.defaultChoice?.selected
      ).toBe(false)
      await mounted.unmount()
    }
  )
  it('carries the host Default preview without replacing the explicit selected model', async () => {
    let reported = true
    const client = optionsClient(async () => ({
      ...OPTIONS,
      ...(reported
        ? {
            defaultModel: {
              id: 'host-original',
              label: 'Host original',
              description: 'Configured model'
            }
          }
        : {})
    }))
    const mounted = await mountOptions({
      ...BASE,
      client: client.client,
      mutate: recordingMutate(async () => accepted({ key: 'model', value: 'gpt-live' }, true))
        .mutate,
      supportsDefault: true
    })
    expect(descriptorFor(mounted.current().optionSnapshot, 'model')?.defaultChoice).toEqual({
      selected: false,
      model: { value: 'host-original', label: 'Host original', description: 'Configured model' }
    })
    expect(currentValueOf(mounted.current().optionSnapshot, 'model')).toBe('gpt-live')
    reported = false
    await mounted.rerender({ optionStamp: 'next-turn' })
    expect(descriptorFor(mounted.current().optionSnapshot, 'model')?.defaultChoice).toEqual({
      selected: false
    })
    await mounted.unmount()
  })
  it.each([false, true])(
    'gates reset on the connected host capability (%s)',
    async (supportsDefault) => {
      let reset = false
      const client = optionsClient(() =>
        Promise.resolve({
          ...OPTIONS,
          current: reset
            ? { model: 'gpt-fast', effort: 'low', modelDefault: true }
            : OPTIONS.current
        })
      )
      const mutation = recordingMutate(async () => {
        reset = true
        return accepted(
          {
            key: 'model',
            value: null,
            modelDefault: true,
            options: { model: 'gpt-fast', effort: 'low' }
          },
          true
        )
      })
      const mounted = await mountOptions({
        agent: 'codex',
        client: client.client,
        sessionId: 'default-phone',
        fence: 1,
        mutate: mutation.mutate,
        supportsDefault
      })
      if (supportsDefault) {
        await act(async () => {
          await mounted.current().optionSurface.resetOption?.('model')
        })
        expect(mutation.calls).toHaveLength(1)
        expect(mutation.calls[0]?.fields).toEqual({ key: 'model', value: null })
        expect(
          mounted.current().optionSnapshot.find((row) => row.id === 'model')?.defaultChoice
            ?.selected
        ).toBe(true)
        expect(client.methods('settings.mutateNativeChatSessionOptions')[0]?.params).toMatchObject({
          type: 'clear-model',
          agent: 'codex'
        })
      } else {
        expect(mounted.current().optionSurface.resetOption).toBeUndefined()
        expect(
          mounted.current().optionSnapshot.find((row) => row.id === 'model')?.defaultChoice
        ).toBeUndefined()
        expect(mutation.calls).toHaveLength(0)
      }
      await mounted.unmount()
    }
  )
})
