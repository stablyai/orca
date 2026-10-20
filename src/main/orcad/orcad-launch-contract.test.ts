/**
 * The two things a supervisor reads off a launch: what the arguments mean, and what an exit
 * code means. Both are part of the supervisor ops contract.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from './orcad-command-arguments'
import { ORCAD_EXIT_CONFIGURATION } from './orcad-configuration-exit'
import { ORCAD_EXIT_FAILED, resolveOrcadExitCode } from './orcad-exit-code'
import { startOrcadWithLifecycle } from './orcad-lifecycle'
import {
  beginAgentSessionRuntimeRecord,
  readAgentSessionRuntimeEnds
} from '../runtime/agent-session-runtime-end-record'
import { OrcadBindAddressError } from './orcad-bind-address'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import { ProfileStateAccessError } from '../persistence/profile-state/profile-state-access'
import { OrcadBundledRuntimeError } from './orcad-bundled-runtime'
import {
  ORCAD_REPOSITORY_ADD_SCRIPTS_CLEANUP_BUDGET_MS,
  registerOrcadRepositoryAddScriptsCleanup
} from '../repository-add-scripts/repository-add-script-shutdown'

describe('parseArgs', () => {
  it('accepts help alongside valid server flags', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true })
    expect(parseArgs(['-h'])).toEqual({ help: true })
    expect(parseArgs(['--json', '--help', '--port', '0'])).toEqual({
      json: true,
      help: true,
      port: 0
    })
  })

  it('keeps help-looking values as values', () => {
    expect(parseArgs(['--bind', '--help'])).toEqual({ bind: '--help' })
    expect(parseArgs(['--pairing-address', '-h'])).toEqual({ pairingAddress: '-h' })
    expect(parseArgs(['--project-root', '--help'])).toEqual({ projectRoot: '--help' })
    expect(parseArgs(['--bind', '--help', '-h'])).toEqual({ bind: '--help', help: true })
  })

  it('still rejects invalid arguments and incompatible flags with help', () => {
    expect(() => parseArgs(['--help', '--unknown'])).toThrow('Unknown argument: --unknown')
    expect(() => parseArgs(['--help', '--port', 'bad'])).toThrow('--port expects an integer')
    expect(() => parseArgs(['--help', '--bind'])).toThrow('--bind expects a value')
    expect(() => parseArgs(['--help', '--recipe-json'])).toThrow(
      'Recipe JSON output requires --project-root.'
    )
    for (const flag of ['--no-pairing', '--mobile-pairing']) {
      expect(() => parseArgs(['--help', '--grant-desktop-control', flag])).toThrow(
        '--grant-desktop-control applies only to the default runtime pairing offer'
      )
    }
  })

  it('accepts the browser client directory orca serve hands it', () => {
    expect(parseArgs(['--web-client-root', '/app/out/web'])).toEqual({
      webClientRoot: '/app/out/web'
    })
    expect(() => parseArgs(['--web-client-root'])).toThrow('--web-client-root expects a value')
  })

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
    expect(parseArgs(['--recipe-json', '--project-root', '/work/app'])).toEqual({
      recipeJson: true,
      projectRoot: '/work/app'
    })
    expect(parseArgs(['--mobile-pairing'])).toEqual({ mobilePairing: true })
    expect(parseArgs(['--no-pairing'])).toEqual({ noPairing: true })
    expect(() => parseArgs(['--recipe-json'])).toThrow(
      'Recipe JSON output requires --project-root.'
    )
    expect(() => parseArgs(['--project-root'])).toThrow('--project-root expects a value')
  })

  it('rejects contradictory pairing flags with the desktop serve message', () => {
    expect(() => parseArgs(['--no-pairing', '--mobile-pairing'])).toThrow(
      'Use either --mobile-pairing or --no-pairing, not both.'
    )
    for (const flag of ['--no-pairing', '--mobile-pairing']) {
      expect(() => parseArgs(['--recipe-json', '--project-root', '/work/app', flag])).toThrow(
        `Recipe JSON output requires runtime pairing; remove ${flag}.`
      )
    }
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

describe('orcad repository add script cleanup', () => {
  function addScriptRuntime(close: () => Promise<void>, unsettled = false) {
    return {
      closeRepositoryAddScripts: vi.fn(close),
      hasUnsettledRepositoryAddScriptRuns: vi.fn(() => unsettled)
    }
  }

  it('seals before RPC stops and spends one budget when startup fails', async () => {
    vi.useFakeTimers()
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const order: string[] = []
      const runtime = addScriptRuntime(() => {
        order.push('close')
        return new Promise<void>(() => {})
      })
      const rpcStop = Promise.withResolvers<void>()
      const earlierCleanup = vi.fn(async () => {})
      const cleanupHost = vi.fn(async () => {})
      const startup = startOrcadWithLifecycle(async (registerCleanup) => {
        registerCleanup(earlierCleanup)
        const addScripts = registerOrcadRepositoryAddScriptsCleanup(runtime, registerCleanup)
        registerCleanup(() => {
          addScripts.start()
          order.push('rpc')
          return rpcStop.promise
        })
        throw new Error('bind failed')
      }, cleanupHost)
      const failed = expect(startup).rejects.toThrow('bind failed')
      await vi.advanceTimersByTimeAsync(0)
      expect(order).toEqual(['close', 'rpc'])
      // The budget started with the RPC cleanup; waiting on RPC does not restart it.
      await vi.advanceTimersByTimeAsync(3_000)
      rpcStop.resolve()
      await vi.advanceTimersByTimeAsync(ORCAD_REPOSITORY_ADD_SCRIPTS_CLEANUP_BUDGET_MS - 3_001)
      expect(earlierCleanup).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      // A timed-out close fails the teardown, but every later cleanup still runs.
      expect(earlierCleanup).toHaveBeenCalledOnce()
      expect(cleanupHost).toHaveBeenCalledExactlyOnceWith(false)
      await failed
      expect(runtime.closeRepositoryAddScripts).toHaveBeenCalledOnce()
      expect(report).toHaveBeenCalledWith(
        '[orcad] startup cleanup failed:',
        new Error('Repository add script cleanup could not be verified.')
      )
    } finally {
      report.mockRestore()
      vi.useRealTimers()
    }
  })

  it('closes once across repeated stops and releases when every run settled', async () => {
    const runtime = addScriptRuntime(async () => {})
    const cleanupHost = vi.fn(async () => {})
    const handle = await startOrcadWithLifecycle(async (registerCleanup) => {
      registerOrcadRepositoryAddScriptsCleanup(runtime, registerCleanup)
      return {}
    }, cleanupHost)
    await Promise.all([handle.stop(), handle.stop()])
    await handle.stop()
    expect(runtime.closeRepositoryAddScripts).toHaveBeenCalledOnce()
    expect(cleanupHost).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each([
    ['a fulfilled close that left a run unverified', addScriptRuntime(async () => {}, true)],
    [
      'a rejected close',
      addScriptRuntime(async () => {
        throw new Error('secret script text')
      })
    ],
    [
      'a close that throws',
      addScriptRuntime(() => {
        throw new Error('secret script text')
      })
    ]
  ])('keeps the fences after %s', async (_name, runtime) => {
    const rpcStop = Promise.withResolvers<void>()
    const cleanupHost = vi.fn(async () => {})
    const handle = await startOrcadWithLifecycle(async (registerCleanup) => {
      const addScripts = registerOrcadRepositoryAddScriptsCleanup(runtime, registerCleanup)
      registerCleanup(() => {
        addScripts.start()
        return rpcStop.promise
      })
      return {}
    }, cleanupHost)
    const stopped = handle.stop()
    // A failed close waits behind a pending RPC stop without becoming an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0))
    rpcStop.resolve()
    await expect(stopped).rejects.toThrow(
      new Error('Repository add script cleanup could not be verified.')
    )
    expect(cleanupHost).toHaveBeenCalledExactlyOnceWith(false)
  })
})
