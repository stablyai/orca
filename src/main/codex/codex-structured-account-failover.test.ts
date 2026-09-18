import { describe, expect, it, vi } from 'vitest'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import {
  fakeCodex,
  identityFor,
  THREAD_ID,
  USER_MESSAGE
} from './codex-structured-session-adapter-fixture'

async function fixture() {
  const codex = fakeCodex()
  const failover = vi.fn(async () => false)
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace',
      codexHome: '/account/a',
      resumeThreadId: THREAD_ID
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1,
    captureTurnProcesses: async () => null,
    failover
  })
  await adapter.acquire({ identity: identityFor('session'), fence: 1, spawnToken: 'spawn' })
  const emit = (method: string, params: Record<string, unknown>) =>
    codex.connections[0].handlers.onNotification?.(method, { threadId: THREAD_ID, ...params })
  const fail = (codexErrorInfo = 'usageLimitExceeded') =>
    emit('turn/completed', { turn: { id: 'turn', status: 'failed', error: { codexErrorInfo } } })
  return { codex, adapter, failover, emit, fail }
}

describe('structured Codex failover admission', () => {
  it('reacts once to a settled quota failure without replaying a prompt or tools', async () => {
    const f = await fixture()
    f.fail()
    f.fail()
    await vi.waitFor(() => expect(f.failover).toHaveBeenCalledTimes(1))
    expect(f.codex.connections[0].calls.map((call) => call.method)).toEqual(['thread/resume'])
    expect(f.codex.connections[0].closeCount).toBe(0)
    await f.adapter.closeAll()
  })
  it.each(['unauthorized', 'rateLimitExceeded', 'serverOverloaded', 'other'])(
    'does not switch for %s',
    async (code) => {
      const f = await fixture()
      f.fail(code)
      expect(f.failover).not.toHaveBeenCalled()
      await f.adapter.closeAll()
    }
  )
  it('does not move a session with an accepted but uncorrelated submission', async () => {
    const f = await fixture()
    await f.adapter.dispatch({
      sessionId: 'session',
      clientMessageId: 'accepted',
      body: USER_MESSAGE,
      fence: 1
    })
    f.fail()
    expect(f.failover).not.toHaveBeenCalled()
    expect(
      f.codex.connections[0].calls.filter((call) => call.method === 'turn/start')
    ).toHaveLength(1)
    await f.adapter.closeAll()
  })
  it('retains approval ownership', async () => {
    const f = await fixture()
    f.codex.connections[0].handlers.onServerRequest?.({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: THREAD_ID, turnId: 'other-turn', itemId: 'tool' }
    })
    f.fail()
    expect(f.failover).not.toHaveBeenCalled()
    expect(f.codex.connections[0].closeCount).toBe(0)
    await f.adapter.closeAll()
  })
  it('blocks new submissions while choosing an account', async () => {
    const f = await fixture()
    let release = (): void => {}
    f.failover.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(false)
        })
    )
    f.fail()
    expect(
      await f.adapter.dispatch({
        sessionId: 'session',
        clientMessageId: 'new',
        body: USER_MESSAGE,
        fence: 1
      })
    ).toMatchObject({ state: 'rejected' })
    release()
    await f.adapter.closeAll()
  })
})
