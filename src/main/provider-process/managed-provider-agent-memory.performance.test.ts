import { describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '@orca/process-host'
import { createFakeSpawnedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { listAgentProcessRoots } from '../memory/agent-process-registry'
import { spawnManagedProviderProcess } from './managed-provider-process'

vi.mock('./provider-process-spawn', () => ({
  spawnProviderProcess: (spec: unknown, spawnImpl: (spec: unknown) => unknown) => spawnImpl(spec)
}))

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function launch(pid: number) {
  const child = createFakeSpawnedChild(pid)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the managed process reads only events, pid and streams from this stub.
  const spawnImpl = (() => child) as unknown as typeof spawnProcess
  spawnManagedProviderProcess(
    { command: 'agent', args: [] },
    { site: 'agent-memory-contract', spawnImpl, platform: 'win32' }
  )
  return child
}

describe('agent memory registrations', () => {
  it('end with their process however it ends, so none outlive it', async () => {
    const ended = Array.from({ length: 100 }, (_, i) => launch(9_000_000 + i))
    await settle()
    ended.forEach((child, i) => {
      if (i % 2 === 0) {
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      } else {
        // A retired identity whose exit status was never recovered ends with close alone.
        child.emit('close', null, null)
      }
    })
    const beforeReady = launch(9_100_000)
    beforeReady.emit('close', null, null)
    const live = launch(9_200_000)
    await settle()

    expect(listAgentProcessRoots()).toEqual([
      { pid: 9_200_000, agentPid: 9_200_000, agentSessionId: null }
    ])
    live.emit('close', null, null)
    expect(listAgentProcessRoots()).toEqual([])
  })
})
