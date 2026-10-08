import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from './provider-process-supervisor'

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 9_999_999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const spawn = vi.fn<typeof spawnProcess>(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies all process fields the managed lifecycle consumes.
    return child as unknown as ReturnType<typeof spawnProcess>
  })
  return { child, spawn }
}

describe('managed provider supervisor grace', () => {
  it.each([false, true])(
    'rejects a short grace before spawning (signal on close: %s)',
    (signalSupervisorOnClose) => {
      const { spawn } = fixture()
      expect(() =>
        spawnManagedProviderProcess(
          { command: 'fixture-provider', args: [] },
          {
            spawnImpl: spawn,
            platform: 'linux',
            site: 'fixture',
            policy: () => ({
              gracefulExitMs: PROVIDER_SUPERVISOR_MAX_STOP_MS - 1,
              forcedExitMs: 50,
              signalSupervisorOnClose
            }),
            acceptClose: (result) => result.root === 'exited'
          }
        )
      ).toThrow(
        `Supervised provider graceful exit must wait at least ${PROVIDER_SUPERVISOR_MAX_STOP_MS} ms`
      )
      expect(spawn).not.toHaveBeenCalled()
    }
  )

  it.each(['linux', 'win32'] as const)(
    'accepts the floor on POSIX and the shorter Windows grace (%s)',
    (platform) => {
      const { child, spawn } = fixture()
      const managed = spawnManagedProviderProcess(
        { command: 'fixture-provider', args: [] },
        {
          spawnImpl: spawn,
          platform,
          site: 'fixture',
          policy: (supervised) => ({
            gracefulExitMs: supervised ? PROVIDER_SUPERVISOR_MAX_STOP_MS : 100,
            forcedExitMs: 50
          }),
          acceptClose: (result) => result.root === 'exited'
        }
      )
      expect(spawn).toHaveBeenCalledOnce()
      expect(managed.rootVerdict).toBe('live')
      child.emit('exit', 0, null)
      expect(managed.rootVerdict).toBe('exited')
    }
  )
})
