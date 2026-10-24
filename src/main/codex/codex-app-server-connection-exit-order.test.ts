import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { registerScriptedProviderChild } from '../provider-process/mock-provider-process-group.test-support'
import { openCodexAppServerConnection } from './codex-app-server-connection'

function stubChild() {
  // Outside any real process table so teardown never mistakes an unrelated process for it.
  const child = registerScriptedProviderChild(createFakePipedChild(9_999_999))
  child.stdin.once('data', () => {
    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The connection reads only events, pid, streams and kill from this stub.
  const spawnImpl = (() => child) as unknown as typeof spawnProcess
  return { child, spawnImpl }
}

describe('Codex app-server exit order', () => {
  it.runIf(process.platform !== 'win32')(
    'spawns Codex directly and closes its request stream',
    async () => {
      const { child } = stubChild()
      child.stdin.once('finish', () => {
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
      const spawnImpl = vi.fn<PipedProcessSpawner>(() => child)
      const connection = await openCodexAppServerConnection(
        { command: 'codex', args: ['app-server'] },
        {},
        spawnImpl
      )
      expect(spawnImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          program: 'codex',
          args: ['app-server'],
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      )
      await connection.close()
      expect(child.stdin.writableEnded).toBe(true)
    }
  )

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

    await vi.waitFor(() => expect(exits).toHaveLength(1))
    expect(exits[0]).toContain('codex crashed')
    await connection.close()
  })
})
