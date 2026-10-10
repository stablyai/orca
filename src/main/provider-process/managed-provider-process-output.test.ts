import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { spawnManagedProviderProcess } from './managed-provider-process'

function launchWithOutput(onOutput: () => void) {
  const child = Object.assign(new EventEmitter(), {
    pid: 9_999_999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const managed = spawnManagedProviderProcess(
    { command: 'fixture-provider', args: [] },
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The managed lifecycle reads only events, pid, streams and kill from this fixture.
      spawnImpl: () => child as unknown as ReturnType<typeof spawnProcess>,
      platform: 'win32',
      site: 'fixture-provider-teardown',
      onOutput
    }
  )
  return { child, managed }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('managed provider process output', () => {
  it('reports stderr and stdout chunks as output', async () => {
    const onOutput = vi.fn()
    const { child } = launchWithOutput(onOutput)
    child.stdout.on('data', () => {})
    await tick()

    child.stderr.write('migrating\n')
    child.stdout.write('{"id":1}\n')
    await tick()

    expect(onOutput).toHaveBeenCalledTimes(2)
  })

  it('never starts stdout before its reader subscribes, so a late reader loses nothing', async () => {
    const onOutput = vi.fn()
    const { child } = launchWithOutput(onOutput)
    child.stdout.write('early frame\n')
    await tick()
    expect(onOutput).not.toHaveBeenCalled()

    const read: string[] = []
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => read.push(chunk))
    await tick()

    expect(read.join('')).toBe('early frame\n')
    expect(onOutput).toHaveBeenCalledTimes(1)
  })
})
