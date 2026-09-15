import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileOmpModelDiscovery } from './use-mobile-omp-model-discovery'
import {
  useMobileNativeChatSessionOptions,
  clearMobileSessionOptionRecordsForTests
} from './use-mobile-native-chat-session-options'

import type { RpcResponse } from '../transport/types'

function reply(result: unknown): RpcResponse {
  return { id: 'discovery', ok: true, result, _meta: { runtimeId: 'host' } }
}

type Args = Parameters<typeof useMobileOmpModelDiscovery>[0]
let renderer: ReactTestRenderer | undefined
let options: ReturnType<typeof useMobileNativeChatSessionOptions>
let switchCapability: string | undefined
let snapshot: ReturnType<typeof useMobileNativeChatSessionOptions>['snapshot'] = []
let args: Args
const reportedModel = 'custom/current'
function Probe(): null {
  const discoveredModels = useMobileOmpModelDiscovery(args)
  options = useMobileNativeChatSessionOptions({
    agent: 'omp',
    scopeKey: `${args.hostId}:${args.worktreeId}`,
    reportedModel,
    discoveredModels,
    modelSwitchCommand: switchCapability,
    dispatchCommand: async () => 'accepted'
  })
  snapshot = options.snapshot
  return null
}
async function mount(client: Args['client']): Promise<void> {
  switchCapability = 'orca-model'
  args = { client, enabled: true, hostId: 'host-a', worktreeId: 'folder:one' }
  await act(async () => {
    renderer = create(createElement(Probe))
  })
}
function modelChoices(): unknown {
  return snapshot.find((row) => row.id === 'model')?.kind
}
beforeEach(() => clearMobileSessionOptionRecordsForTests())
afterEach(() => {
  act(() => renderer?.unmount())
})
const listed = {
  success: true,
  catalogOrigin: 'probe',
  models: [{ id: 'provider/new', label: 'New model' }]
}

describe('mobile OMP model discovery and picker choices', () => {
  it('queries the execution workspace and retains the current model beside configured choices', async () => {
    const sendRequest = vi.fn(async () => reply(listed))
    await mount({ sendRequest })
    expect(sendRequest).toHaveBeenCalledWith(
      'git.discoverCommitMessageModels',
      {
        worktree: 'id:folder:one',
        agentId: 'omp'
      },
      undefined
    )
    expect(modelChoices()).toMatchObject({
      currentValue: reportedModel,
      choices: expect.arrayContaining([
        expect.objectContaining({ value: 'provider/new', label: 'New model' }),
        expect.objectContaining({ value: reportedModel })
      ])
    })
  })
  it('makes discovered choices selectable only after the live extension advertises support', async () => {
    await mount({ sendRequest: vi.fn(async () => reply(listed)) })
    expect(snapshot[0]?.settable).toBe(true)
    await act(async () => {
      expect(await options.setOption('model', 'provider/new')).toBe(true)
    })
    await act(async () => {
      switchCapability = undefined
      renderer!.update(createElement(Probe))
    })
    expect(snapshot[0]?.settable).toBe(false)
    await act(async () => {
      expect(await options.setOption('model', reportedModel)).toBe(false)
    })
  })
  it.each([
    new Error('Unknown method'),
    { success: false, error: 'SSH unavailable' },
    { ...listed, catalogOrigin: 'spec' },
    { success: true, models: listed.models }
  ])('keeps the hook model on failure or an older host response', async (value) => {
    const sendRequest = vi.fn(async () => {
      if (value instanceof Error) {
        throw value
      }
      return reply(value)
    })
    await mount({ sendRequest })
    expect(modelChoices()).toMatchObject({
      currentValue: reportedModel,
      choices: [expect.objectContaining({ value: reportedModel })]
    })
  })
  it('does not expose a previous host response after changing hosts', async () => {
    let resolve!: (value: RpcResponse) => void
    await mount({
      sendRequest: vi.fn(
        () =>
          new Promise<RpcResponse>((r) => {
            resolve = r
          })
      )
    })
    await act(async () => {
      args = {
        ...args,
        hostId: 'host-b',
        client: {
          sendRequest: vi.fn(async () =>
            reply({
              ...listed,
              models: [{ id: 'other/host', label: 'Other' }]
            })
          )
        }
      }
      renderer!.update(createElement(Probe))
    })
    await act(async () => {
      resolve(reply(listed))
    })
    expect(modelChoices()).toMatchObject({
      choices: expect.arrayContaining([expect.objectContaining({ value: 'other/host' })])
    })
    expect(JSON.stringify(modelChoices())).not.toContain('provider/new')
  })
})
