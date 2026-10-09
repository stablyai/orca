/**
 * The two things a supervisor reads off a launch: what the arguments mean, and what an exit
 * code means. Both are part of the ops contract in docs/reference/orcad-operations.md.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from './orcad-entry'
import {
  ORCAD_EXIT_CONFIGURATION,
  ORCAD_EXIT_FAILED,
  resolveOrcadExitCode
} from './orcad-exit-code'
import { startOrcadWithLifecycle } from './orcad-lifecycle'
import {
  beginAgentSessionRuntimeRecord,
  readAgentSessionRuntimeEnds
} from '../runtime/agent-session-runtime-end-record'
import { OrcadBindAddressError } from './orcad-bind-address'
import { OrcadInstanceLockError } from './orcad-instance-lock'
import { ProfileStateAccessError } from '../persistence/profile-state/profile-state-access'
import { OrcadBundledRuntimeError } from './orcad-bundled-runtime'

describe('parseArgs', () => {
  it('accepts --bind and leaves it unset when absent', () => {
    expect(parseArgs(['--bind', '0.0.0.0'])).toEqual({ bind: '0.0.0.0' })
    expect(parseArgs([])).toEqual({})
    expect(parseArgs(['--port', '6768', '--bind', '10.0.0.5', '--json'])).toEqual({
      port: 6768,
      bind: '10.0.0.5',
      json: true
    })
  })

  it('takes the desktop serve flags orca serve forwards', () => {
    expect(
      parseArgs([
        '--mobile-pairing',
        '--recipe-json',
        '--project-root',
        '/work/app',
        '--no-pairing'
      ])
    ).toEqual({
      mobilePairing: true,
      recipeJson: true,
      projectRoot: '/work/app',
      noPairing: true
    })
    expect(() => parseArgs(['--recipe-json'])).toThrow('--recipe-json requires --project-root')
    expect(() => parseArgs(['--project-root'])).toThrow('--project-root expects a value')
  })

  it('rejects --bind with no value rather than silently binding the default', () => {
    expect(() => parseArgs(['--bind'])).toThrow('--bind expects a value')
    expect(() => parseArgs(['--bind', '--json'])).not.toThrow()
  })
})

describe('resolveOrcadExitCode', () => {
  it('separates a configuration fault from a generic failure', () => {
    // A supervisor must be able to stop restarting on faults that restarting cannot fix:
    // a data root owned by someone else, held by another instance, or a bad bind address.
    expect(
      resolveOrcadExitCode(new OrcadInstanceLockError('orcad_instance_lock_held', 'held'))
    ).toBe(ORCAD_EXIT_CONFIGURATION)
    expect(resolveOrcadExitCode(new OrcadBindAddressError('bad'))).toBe(ORCAD_EXIT_CONFIGURATION)
    expect(resolveOrcadExitCode(new ProfileStateAccessError('recovery interrupted'))).toBe(
      ORCAD_EXIT_CONFIGURATION
    )
    expect(resolveOrcadExitCode(new Error('port in use'))).toBe(ORCAD_EXIT_FAILED)
    expect(resolveOrcadExitCode(new OrcadBundledRuntimeError('partial installation'))).toBe(
      ORCAD_EXIT_CONFIGURATION
    )
    expect(ORCAD_EXIT_CONFIGURATION).not.toBe(ORCAD_EXIT_FAILED)
  })
})

describe('orcad lifecycle cleanup', () => {
  it('uninstalls registered runtime resources when startup fails', async () => {
    const cleanupRuntime = vi.fn(async () => {})
    const cleanupHost = vi.fn(async () => {})

    await expect(
      startOrcadWithLifecycle(async (registerCleanup) => {
        registerCleanup(cleanupRuntime)
        await Promise.resolve()
        throw new Error('startup failed')
      }, cleanupHost)
    ).rejects.toThrow('startup failed')

    expect(cleanupRuntime).toHaveBeenCalledOnce()
    expect(cleanupHost).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('preserves the startup error when rollback also fails', async () => {
    const startupError = new Error('bind failed')
    const cleanupError = new Error('daemon stop failed')
    const cleanupRuntime = vi.fn(async () => {})
    const cleanupHost = vi.fn(async () => {
      throw cleanupError
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(
        startOrcadWithLifecycle(async (registerCleanup) => {
          registerCleanup(cleanupRuntime)
          throw startupError
        }, cleanupHost)
      ).rejects.toBe(startupError)
      expect(report).toHaveBeenCalledWith('[orcad] startup cleanup failed:', cleanupError)
    } finally {
      report.mockRestore()
    }
  })

  it('coalesces concurrent and repeated normal stops', async () => {
    const cleanupRuntime = vi.fn(async () => {})
    const cleanupHost = vi.fn(async () => {})
    const handle = await startOrcadWithLifecycle(async (registerCleanup) => {
      registerCleanup(cleanupRuntime)
      return { readiness: 'ready' }
    }, cleanupHost)

    await Promise.all([handle.stop(), handle.stop()])
    await handle.stop()

    expect(cleanupRuntime).toHaveBeenCalledOnce()
    expect(cleanupHost).toHaveBeenCalledOnce()
  })

  it("records the runtime's end before its stop waits on anything", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orcad-runtime-end-'))
    try {
      beginAgentSessionRuntimeRecord(directory, 'orcad-runtime', 1)
      let endSeenByCleanup: string | undefined
      const handle = await startOrcadWithLifecycle(
        async (registerCleanup) => {
          registerCleanup(async () => {
            endSeenByCleanup = readAgentSessionRuntimeEnds(directory)?.get('orcad-runtime')
          })
          return {}
        },
        vi.fn(async () => {})
      )

      await handle.stop()

      // A chat whose agent dies with this stop reads as a restart, not a crash.
      expect(endSeenByCleanup).toBe('quit')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps the host aware of failed runtime teardown so it cannot release profile admission', async () => {
    const failure = new Error('profile writer still running')
    const cleanupHost = vi.fn(async () => {})
    const handle = await startOrcadWithLifecycle(async (registerCleanup) => {
      registerCleanup(async () => {
        throw failure
      })
      return {}
    }, cleanupHost)
    await expect(handle.stop()).rejects.toBe(failure)
    expect(cleanupHost).toHaveBeenCalledExactlyOnceWith(false)
  })
})
