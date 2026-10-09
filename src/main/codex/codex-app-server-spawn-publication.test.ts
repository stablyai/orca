import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { spawnCodexAppServerConnection } from './codex-app-server-connection'
import { initializeCodexAppServerConnection } from './codex-app-server-handshake'

it('publishes the transport after identity recording and sends initialize only when asked', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 9_999_999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const written: string[] = []
  child.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))
  child.stdin.on('finish', () => child.emit('exit', 0, null))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The transport uses only this stub's pid, event emitter, streams and kill.
  const spawnImpl = (() => child) as unknown as typeof spawnProcess
  const identity = Promise.withResolvers<void>()
  const onSpawned = vi.fn(() => identity.promise)
  const opening = spawnCodexAppServerConnection(
    { command: '/nonexistent/scripted-codex', args: [] },
    { onSpawned },
    spawnImpl
  )
  await vi.waitFor(() => expect(onSpawned).toHaveBeenCalledWith(child.pid))
  expect(written).toEqual([])
  identity.resolve()
  const connection = await opening
  expect(connection.pid).toBe(child.pid)
  expect(written).toEqual([])
  const initializing = initializeCodexAppServerConnection(connection)
  expect(written[0]).toContain('initialize')
  child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`)
  await initializing
  expect(written.at(-1)).toContain('initialized')
  expect(await connection.close()).toBe(true)
})
