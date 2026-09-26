import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { KANEO_METHODS } from './kaneo'

describe('Kaneo RPC boundary', () => {
  it('validates untrusted params before calling the host and routes valid calls', async () => {
    const runtime = {
      getRuntimeId: () => 'test',
      kaneoConnect: vi.fn(),
      kaneoGetTask: vi.fn(),
      kaneoStatus: vi.fn(),
      kaneoDisconnect: vi.fn()
    }
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: KANEO_METHODS
    })
    const call = (method: string, params?: unknown) =>
      dispatcher.dispatch({ id: 'test', authToken: 'test', method, params })
    await call('kaneo.connect', { siteUrl: 123, apiKey: [] })
    await call('kaneo.getTask', { url: 'a'.repeat(2049) })
    expect(runtime.kaneoConnect).not.toHaveBeenCalled()
    expect(runtime.kaneoGetTask).not.toHaveBeenCalled()
    await call('kaneo.connect', { siteUrl: ' https://tasks.example.com ', apiKey: ' test-key ' })
    expect(runtime.kaneoConnect).toHaveBeenCalledWith({
      siteUrl: 'https://tasks.example.com',
      apiKey: 'test-key'
    })
    await call('kaneo.getTask', { url: 'task-url' })
    expect(runtime.kaneoGetTask).toHaveBeenCalledWith('task-url', undefined)
    await call('kaneo.status')
    await call('kaneo.disconnect')
    expect(runtime.kaneoStatus).toHaveBeenCalledOnce()
    expect(runtime.kaneoDisconnect).toHaveBeenCalledOnce()
  })
})
