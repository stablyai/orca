import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { MOBILE_WEB_SESSION_TERMINAL_CREATION_METHODS } from './mobile-web-session-terminal-creation'

const [options, create] = MOBILE_WEB_SESSION_TERMINAL_CREATION_METHODS
function fixture() {
  const runtime = {
    getMobileSessionAgentOptions: vi.fn().mockResolvedValue(['codex']),
    createMobileSessionTerminal: vi.fn().mockResolvedValue({
      worktree: '/private/root',
      tab: { type: 'terminal', id: 'tab', terminal: 'secret' }
    })
  }
  const controller = new AbortController()
  const context = {
    runtime,
    signal: controller.signal,
    clientKind: 'mobile',
    pairedDeviceId: 'device'
  } as unknown as RpcContext
  const params = { worktree: 'id:folder:folder', clientMutationId: 'operation', timeoutMs: 15_000 }
  return { runtime, controller, context, params }
}
afterEach(() => vi.useRealTimers())
describe('host-owned session terminal creation', () => {
  it('returns only enabled detected agents for the authoritative workspace', async () => {
    const f = fixture()
    expect(await options.handler(f.params, f.context)).toEqual({ agents: ['codex'] })
    expect(f.runtime.getMobileSessionAgentOptions).toHaveBeenCalledWith(f.params.worktree)
  })
  it.each([undefined, 'codex'] as const)(
    'creates %s through the existing caller navigation/idempotency path',
    async (agent) => {
      const f = fixture()
      expect(await create.handler({ ...f.params, agent }, f.context)).toEqual({
        tabId: 'tab',
        created: true
      })
      expect(f.runtime.createMobileSessionTerminal).toHaveBeenCalledWith(
        f.params.worktree,
        expect.objectContaining({
          agent,
          clientMutationId: 'operation',
          clientNavigationId: 'device',
          navigation: 'caller',
          activate: true,
          select: true,
          signal: f.controller.signal
        })
      )
    }
  )
  it('refuses an unavailable or disabled agent before creation', async () => {
    const f = fixture()
    await expect(create.handler({ ...f.params, agent: 'claude' }, f.context)).rejects.toThrow(
      'invalid_params'
    )
    expect(f.runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })
  it.each(['timeout', 'disconnect'])(
    'fences creation after agent detection on %s',
    async (reason) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      const f = fixture()
      f.runtime.getMobileSessionAgentOptions.mockImplementationOnce(async () => {
        if (reason === 'timeout') {
          vi.setSystemTime(16_000)
        } else {
          f.controller.abort()
        }
        return ['codex']
      })
      await expect(create.handler({ ...f.params, agent: 'codex' }, f.context)).rejects.toThrow(
        'runtime_unavailable'
      )
      expect(f.runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
    }
  )
  it('does not retry an ambiguous runtime creation failure', async () => {
    const f = fixture()
    f.runtime.createMobileSessionTerminal.mockRejectedValue(new Error('disconnected'))
    await expect(create.handler(f.params, f.context)).rejects.toThrow('disconnected')
    expect(f.runtime.createMobileSessionTerminal).toHaveBeenCalledTimes(1)
  })
})
