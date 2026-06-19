import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { PersistedUIState } from '../../../shared/types'
import { getDefaultUIState } from '../../../shared/constants'
import {
  ORCA_RUNTIME_RPC_BROWSER_UI_SOURCE,
  ORCA_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY
} from '../../../shared/runtime-rpc-feature-interaction-source'
import { RpcDispatcher } from './dispatcher'
import { defineMethod, defineStreamingMethod, type RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'

function makeRequest(method: string, params: unknown = {}): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntime(ui: PersistedUIState = getDefaultUIState()): OrcaRuntimeService {
  let currentUI = ui
  return {
    getRuntimeId: () => 'test-runtime',
    getUIState: vi.fn(() => currentUI),
    recordFeatureInteraction: vi.fn((id) => {
      const featureInteractions = currentUI.featureInteractions ?? {}
      const existing = featureInteractions[id]
      currentUI = {
        ...currentUI,
        featureInteractions: {
          ...featureInteractions,
          [id]: {
            firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
            interactionCount: (existing?.interactionCount ?? 0) + 1
          }
        }
      }
      return currentUI
    }),
    updateUIState: vi.fn((updates: Partial<PersistedUIState>) => {
      currentUI = { ...currentUI, ...updates }
      return currentUI
    })
  } as unknown as OrcaRuntimeService
}

const METHODS = [
  defineMethod({
    name: 'browser.click',
    params: z.object({}),
    handler: () => ({ clicked: true })
  }),
  defineMethod({
    name: 'browser.tabCreate',
    params: z.object({}),
    handler: () => ({ browserPageId: 'page-1' })
  }),
  defineMethod({
    name: 'browser.tabShow',
    params: z.object({}),
    handler: () => ({ tab: { id: 'page-1' } })
  }),
  defineMethod({
    name: 'browser.viewport',
    params: z.object({}),
    handler: () => ({ ok: true })
  }),
  defineMethod({
    name: 'browser.eval',
    params: z.object({}),
    handler: () => ({ value: 'ok' })
  }),
  defineStreamingMethod({
    name: 'browser.screencast',
    params: z.object({}),
    handler: async (_params, _options, emit) => {
      emit({ type: 'frame' })
      emit({ type: 'end' })
    }
  }),
  defineStreamingMethod({
    name: 'browser.screencast.binaryOnly',
    params: z.object({}),
    handler: async () => {}
  }),
  defineMethod({
    name: 'browser.screencast.unsubscribe',
    params: z.object({}),
    handler: () => ({ ok: true })
  }),
  defineMethod({
    name: 'browser.profileImportFromBrowser',
    params: z.object({}),
    handler: () => ({ ok: true })
  }),
  defineMethod({
    name: 'browser.profileList',
    params: z.object({}),
    handler: () => ({ profiles: [] })
  }),
  defineMethod({
    name: 'browser.profileClearDefaultCookies',
    params: z.object({}),
    handler: () => ({ cleared: false })
  }),
  defineMethod({
    name: 'computer.permissions',
    params: z.object({}),
    handler: () => ({ opened: true })
  }),
  defineMethod({
    name: 'computer.permissionsStatus',
    params: z.object({}),
    handler: () => ({ permissions: [] })
  }),
  defineMethod({
    name: 'computer.click',
    params: z.object({}),
    handler: () => ({ clicked: true })
  }),
  defineMethod({
    name: 'orchestration.send',
    params: z.object({}),
    handler: () => ({ id: 'msg-1' })
  }),
  defineMethod({
    name: 'browser.fail',
    params: z.object({}),
    handler: () => {
      throw new Error('nope')
    }
  })
]

describe('RpcDispatcher feature interactions', () => {
  it('records runtime feature use after successful runtime tool methods', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    await dispatcher.dispatch(makeRequest('browser.click'))
    await dispatcher.dispatch(makeRequest('computer.click'))
    await dispatcher.dispatch(makeRequest('orchestration.send'))

    expect(runtime.recordFeatureInteraction).toHaveBeenCalledWith('agent-browser-use')
    expect(runtime.recordFeatureInteraction).toHaveBeenCalledWith('computer-use')
    expect(runtime.recordFeatureInteraction).toHaveBeenCalledWith('agent-orchestration')
  })

  it('keeps setup and cookie import separate from actual runtime use', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    await dispatcher.dispatch(makeRequest('computer.permissions'))
    await dispatcher.dispatch(makeRequest('computer.permissionsStatus'))
    await dispatcher.dispatch(makeRequest('browser.profileImportFromBrowser'))
    await dispatcher.dispatch(makeRequest('browser.profileList'))
    await dispatcher.dispatch(makeRequest('browser.profileClearDefaultCookies'))

    expect(runtime.recordFeatureInteraction).toHaveBeenCalledWith('computer-use-setup')
    expect(runtime.recordFeatureInteraction).toHaveBeenCalledWith('cookie-import')
    expect(runtime.recordFeatureInteraction).toHaveBeenCalledTimes(2)
  })

  it('does not record failed runtime methods', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    await dispatcher.dispatch(makeRequest('browser.fail'))

    expect(runtime.recordFeatureInteraction).not.toHaveBeenCalled()
  })

  it('records unmarked browser display RPCs as agent browser use', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const replies: string[] = []

    await dispatcher.dispatch(makeRequest('browser.tabCreate'))
    await dispatcher.dispatch(makeRequest('browser.tabShow'))
    await dispatcher.dispatch(makeRequest('browser.screencast.unsubscribe'))
    expect(runtime.recordFeatureInteraction).toHaveBeenCalledTimes(2)
    expect(runtime.recordFeatureInteraction).toHaveBeenNthCalledWith(1, 'agent-browser-use')
    expect(runtime.recordFeatureInteraction).toHaveBeenNthCalledWith(2, 'agent-browser-use')

    await dispatcher.dispatchStreaming(makeRequest('browser.screencast'), (response) => {
      replies.push(response)
    })

    expect(replies).toHaveLength(2)
    expect(runtime.recordFeatureInteraction).toHaveBeenCalledTimes(3)
    expect(runtime.recordFeatureInteraction).toHaveBeenLastCalledWith('agent-browser-use')
  })

  it('records binary-only browser display streams as agent browser use', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(makeRequest('browser.screencast.binaryOnly'), (response) => {
      replies.push(response)
    })

    expect(replies).toHaveLength(0)
    expect(runtime.recordFeatureInteraction).toHaveBeenCalledTimes(1)
    expect(runtime.recordFeatureInteraction).toHaveBeenCalledWith('agent-browser-use')
  })

  it('does not record browser pane UI-originated browser RPCs as agent browser use', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const browserPaneUiParams = {
      [ORCA_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: ORCA_RUNTIME_RPC_BROWSER_UI_SOURCE
    }

    await dispatcher.dispatch(makeRequest('browser.viewport', browserPaneUiParams))
    await dispatcher.dispatch(makeRequest('browser.eval', browserPaneUiParams))
    await dispatcher.dispatchStreaming(
      makeRequest('browser.screencast', browserPaneUiParams),
      () => {}
    )
    await dispatcher.dispatch(makeRequest('browser.click'))

    expect(runtime.recordFeatureInteraction).toHaveBeenCalledTimes(1)
    expect(runtime.recordFeatureInteraction).toHaveBeenCalledWith('agent-browser-use')
  })

  it('records each successful non-streaming runtime feature interaction', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    await dispatcher.dispatch(makeRequest('browser.click'))
    await dispatcher.dispatch(makeRequest('browser.click'))
    await dispatcher.dispatch(makeRequest('browser.screencast.unsubscribe'))

    expect(runtime.recordFeatureInteraction).toHaveBeenCalledTimes(2)
    expect(runtime.recordFeatureInteraction).toHaveBeenLastCalledWith('agent-browser-use')
  })
})
