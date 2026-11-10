import { afterEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext, type RpcStreamingMethod } from '../../core'
import type { PluginService } from '../../../../plugins/plugin-service'
import { PLUGIN_PANEL_SESSION_METHODS } from './plugin-panel-session'
import { setPluginServiceForRpc } from './plugins'

afterEach(() => setPluginServiceForRpc(null))

describe('plugins.panelSession', () => {
  const HOST_TOKEN = 'h'.repeat(43)

  function panelSession(): RpcStreamingMethod {
    const found = eraseRpcMethods(PLUGIN_PANEL_SESSION_METHODS).find(
      (entry) => entry.name === 'plugins.panelSession'
    )
    if (!found || !('stream' in found)) {
      throw new Error('missing streaming plugins.panelSession')
    }
    return found
  }

  function host(consentFingerprint: string) {
    const cleanups = new Map<string, () => void>()
    const deliver: { push?: (push: unknown) => void } = {}
    const stopBridge = vi.fn()
    const service = {
      whenReady: vi.fn().mockResolvedValue(undefined),
      findValidPlugin: vi.fn().mockReturnValue({ consentFingerprint }),
      panels: {
        bindOwnerSignal: vi.fn(),
        open: vi.fn().mockResolvedValue({ html: '', sessionToken: HOST_TOKEN }),
        sessionCaller: vi.fn().mockReturnValue({
          pluginKey: 'acme.notes',
          caller: { id: 'panel-1', surface: 'panel', contributionId: 'main' }
        }),
        revokeOwner: vi.fn(),
        revokeSession: vi.fn()
      },
      panelBridge: {
        open: vi.fn((_caller: unknown, _key: string, push: (push: unknown) => void) => {
          deliver.push = push
          return stopBridge
        })
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: panelSession reads only the members stubbed above.
    setPluginServiceForRpc(service as unknown as PluginService)
    const runtime = {
      registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup)
    }
    const context: RpcContext = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: panelSession only registers its cleanup on the runtime.
      runtime: runtime as unknown as RpcContext['runtime'],
      connectionId: 'socket-1',
      requestId: 'request-1',
      caller: { kind: 'local-cli' }
    }
    return { service, cleanups, deliver, stopBridge, context }
  }

  const params = {
    pluginKey: 'acme.notes',
    panelId: 'main',
    consentFingerprint: 'fp-1'
  }

  it('runs the panel for the stream socket until that socket closes', async () => {
    const { service, cleanups, deliver, stopBridge, context } = host('fp-1')
    const emit = vi.fn()
    const done = panelSession().handler(params, context, emit)
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith({
        type: 'ready',
        sessionToken: HOST_TOKEN
      })
    )
    expect(service.panels.open).toHaveBeenCalledWith('runtime:socket-1', 'acme.notes', 'main')

    deliver.push?.({ kind: 'post', data: 1 })
    expect(emit).toHaveBeenCalledWith({
      type: 'push',
      push: { kind: 'post', data: 1 }
    })

    for (const cleanup of cleanups.values()) {
      cleanup()
    }
    await done
    expect(stopBridge).toHaveBeenCalled()
    expect(service.panels.revokeSession).toHaveBeenCalledWith('runtime:socket-1', HOST_TOKEN)
    expect(emit).toHaveBeenLastCalledWith({ type: 'end' })
  })

  it('keeps a panel session that another stream on the socket still uses', async () => {
    const { service, cleanups, context } = host('fp-1')
    const first = panelSession().handler(params, context, vi.fn())
    const second = panelSession().handler(params, { ...context, requestId: 'request-2' }, vi.fn())
    await vi.waitFor(() => expect(cleanups.size).toBe(2))
    const [endFirst, endSecond] = [...cleanups.values()]

    endFirst?.()
    await first
    expect(service.panels.revokeSession).not.toHaveBeenCalled()

    endSecond?.()
    await second
    expect(service.panels.revokeSession).toHaveBeenCalledWith('runtime:socket-1', HOST_TOKEN)
  })

  it("leaves the socket's other panels open when the panel is missing", async () => {
    const { service, context } = host('fp-1')
    service.panels.open.mockResolvedValue(null)
    await expect(panelSession().handler(params, context, vi.fn())).rejects.toThrow(
      'has no panel main'
    )
    expect(service.panels.revokeOwner).not.toHaveBeenCalled()
  })

  it('refuses a client whose copy of the plugin differs', async () => {
    const { service, context } = host('fp-other')
    await expect(panelSession().handler(params, context, vi.fn())).rejects.toThrow(
      'does not have the same acme.notes'
    )
    expect(service.panels.open).not.toHaveBeenCalled()
  })
})
