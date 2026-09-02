import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

const RESOLUTION = { text: 'seed', createdAt: 1 }

function makeRequest(params: unknown): RpcRequest {
  return { id: 'request', authToken: 'token', method: 'terminal.send', params }
}

function makeRuntime(accepted: boolean): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'runtime',
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    beginMobileInputFloor: vi.fn().mockReturnValue({ commit: vi.fn(), rollback: vi.fn() }),
    sendTerminal: vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted,
      bytesWritten: accepted ? 1 : 0
    }),
    notifyNativeChatLaunchDraftResolved: vi.fn()
  } as unknown as OrcaRuntimeService
}

async function send(
  runtime: OrcaRuntimeService,
  options: { enter: boolean; clientType: 'mobile' | 'desktop' }
): Promise<void> {
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  await dispatcher.dispatch(
    makeRequest({
      terminal: 'terminal-1',
      text: 'hello',
      enter: options.enter,
      resolvedLaunchDraft: RESOLUTION,
      client: { id: 'client-1', type: options.clientType }
    })
  )
}

describe('terminal.send launch-draft resolution', () => {
  it('notifies after an accepted mobile submit', async () => {
    const runtime = makeRuntime(true)

    await send(runtime, { enter: true, clientType: 'mobile' })

    expect(runtime.notifyNativeChatLaunchDraftResolved).toHaveBeenCalledWith(
      'terminal-1',
      RESOLUTION
    )
  })

  it.each([
    ['rejected submit', false, true, 'mobile'],
    ['clear-only write', true, false, 'mobile'],
    ['desktop submit', true, true, 'desktop']
  ] as const)('does not notify after a %s', async (_case, accepted, enter, clientType) => {
    const runtime = makeRuntime(accepted)

    await send(runtime, { enter, clientType })

    expect(runtime.notifyNativeChatLaunchDraftResolved).not.toHaveBeenCalled()
  })
})
