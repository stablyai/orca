// #46567: only a user's call that the idle stop never dispatched is sent again.
import { describe, expect, it } from 'vitest'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { resumeAfterIdleStop } from './runtime-environment-idle-stop-resume'

const ok: RuntimeRpcResponse<string> = {
  id: '1',
  ok: true,
  result: 'done',
  _meta: { runtimeId: 'r' }
}
const refused: RuntimeRpcResponse<string> = {
  id: '1',
  ok: false,
  error: { code: 'runtime_idle_stopped', message: 'stopped idle' },
  _meta: { runtimeId: 'r' }
}

function attempts(first: () => Promise<RuntimeRpcResponse<string>>) {
  let sent = 0
  return {
    attempt: () => (++sent === 1 ? first() : Promise.resolve(ok)),
    sent: () => sent
  }
}

describe('resending a call after an idle stop', () => {
  it('resends a user call the stop refused or left unanswered', async () => {
    for (const first of [
      () => Promise.resolve(refused),
      () => Promise.reject(new RemoteRuntimeClientError('runtime_idle_stopped', 'closed'))
    ]) {
      const calls = attempts(first)
      await expect(resumeAfterIdleStop(calls.attempt, true)).resolves.toBe(ok)
      expect(calls.sent()).toBe(2)
    }
  })

  it('never resends a poll, or a call that may have run', async () => {
    const poll = attempts(() => Promise.resolve(refused))
    await expect(resumeAfterIdleStop(poll.attempt, false)).resolves.toBe(refused)
    expect(poll.sent()).toBe(1)

    const crashed = attempts(() =>
      Promise.reject(new RemoteRuntimeClientError('remote_runtime_unavailable', 'closed'))
    )
    await expect(resumeAfterIdleStop(crashed.attempt, true)).rejects.toMatchObject({
      code: 'remote_runtime_unavailable'
    })
    expect(crashed.sent()).toBe(1)
  })
})
