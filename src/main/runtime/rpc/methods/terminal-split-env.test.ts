import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { TERMINAL_METHODS } from './terminal'

describe('terminal split environment forwarding', () => {
  it('forwards requested environment deletions to the runtime owner', async () => {
    const splitTerminal = vi.fn().mockResolvedValue({ handle: 'term-split' })
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      splitTerminal
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const request: RpcRequest = {
      id: 'split-1',
      authToken: 'token',
      method: 'terminal.split',
      params: {
        terminal: 'term-1',
        direction: 'horizontal',
        env: { ORCA_ATTRIBUTION_BYPASS: '1' },
        envToDelete: ['ORCA_ENABLE_GIT_ATTRIBUTION']
      }
    }

    await dispatcher.dispatch(request)

    expect(splitTerminal).toHaveBeenCalledWith('term-1', {
      direction: 'horizontal',
      command: undefined,
      env: { ORCA_ATTRIBUTION_BYPASS: '1' },
      envToDelete: ['ORCA_ENABLE_GIT_ATTRIBUTION'],
      telemetrySource: undefined
    })
  })
})
