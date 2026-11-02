import { AgentSessionAcquisitionRootExitObservedError } from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { findInErrorChain } from '../../provider-process/provider-error-chain'
import { providerRequestTimeoutOf } from '../../provider-process/provider-request-timeout'
import { CodexAppServerTimeoutError } from './codex-app-server-session'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { openCodexAppServerConnection } from './codex-app-server-connection'

afterEach(() => vi.useRealTimers())

it('ends a direct open and reaps its child when initialize never answers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const child = createFakePipedChild(9_999_999)
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.stdin.on('finish', () => {
    child.emit('exit', 0, null)
    child.stdout.end()
  })
  const opening = openCodexAppServerConnection(
    { command: 'codex', args: ['app-server'] },
    {},
    () => child
  ).catch((error: unknown) => error)

  await vi.advanceTimersByTimeAsync(14_999)
  expect(child.stdin.writableEnded).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  const failure = await opening
  expect(failure).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
  expect(
    findInErrorChain(failure, (error) =>
      error instanceof CodexAppServerTimeoutError ? error : undefined
    )
  ).toMatchObject({ name: 'CodexAppServerTimeoutError' })
  expect(providerRequestTimeoutOf(failure)).toEqual({ method: 'initialize', timeoutMs: 15_000 })
  expect(child.stdout.readableEnded).toBe(true)
  expect(child.stdin.writableEnded).toBe(true)
})
