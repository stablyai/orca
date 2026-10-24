import { registerScriptedProviderChild } from '../provider-process/mock-provider-process-group.test-support'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakePipedChild
} from '../../shared/__fixtures__/fake-spawned-child'
import { openCodexAppServerConnection } from './codex-app-server-connection'

afterEach(() => vi.useRealTimers())

it('ends a direct open and reaps its child when initialize never answers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const child = createFakePipedChild(9_999_999)
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.stdin.on('finish', () => completeFakeSpawn(child))
  const opening = openCodexAppServerConnection({ command: 'codex', args: ['app-server'] }, {}, () =>
    registerScriptedProviderChild(child)
  ).catch((error: unknown) => error)

  await vi.advanceTimersByTimeAsync(14_999)
  expect(child.stdin.writableEnded).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await opening).toMatchObject({ name: 'CodexAppServerTimeoutError' })
  expect(child.stdin.writableEnded).toBe(true)
})
