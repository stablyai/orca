import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { openCodexAppServerConnection } from './codex-app-server-connection'

function stubChild() {
  const child = Object.assign(new EventEmitter(), {
    // Outside any real process table so teardown never mistakes an unrelated process for it.
    pid: 9_999_999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  child.stdin.once('data', () => {
    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The connection reads only events, pid, streams and kill from this stub.
  const spawnImpl = (() => child) as unknown as typeof spawnProcess
  return { child, spawnImpl }
}

describe('Codex app-server exit order', () => {
  // Stdout can end before the exit is seen, as when the provider supervisor's own exit closes it.
  it('reports an exit whose stdout ended first once the exit is seen, with its usual reason', async () => {
    const { child, spawnImpl } = stubChild()
    const exits: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit: (error) => exits.push(error.message) },
      spawnImpl
    )

    child.stderr.write('codex crashed\n')
    child.stdout.end()
    // Stream writes land a tick later, so the stderr tail is only complete here.
    await new Promise((resolve) => setImmediate(resolve))
    expect(exits).toEqual([])
    child.emit('exit', 1, null)
    child.emit('close', 1, null)

    expect(exits).toHaveLength(1)
    expect(exits[0]).toContain('codex crashed')
    await connection.close()
  })
})
