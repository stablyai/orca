import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/orcad-profile-preflight'
import {
  ORCAD_CANCEL_MANAGED_STOP_FLAG,
  ORCAD_COMPLETE_MANAGED_STOP_FLAG
} from '../../shared/orcad-stop-request'

// Preflight must precede PTY imports because native loader failures may be uncatchable.
const { order, profileProbe, reserveStdout, slot } = vi.hoisted(() => {
  const order: string[] = []
  const slot: { qualified: boolean; verdict: 'ok' | 'degraded' } = {
    qualified: false,
    verdict: 'ok'
  }
  return { order, profileProbe: vi.fn(async () => {}), reserveStdout: vi.fn(), slot }
})

vi.mock('../server/serve-stdout-boundary', () => ({
  reserveServeStdoutForReadiness: reserveStdout
}))
vi.mock('./orcad-bundled-runtime', () => ({
  assertOrcadServerRuntime: () => {},
  OrcadBundledRuntimeError: class extends Error {}
}))
vi.mock('./orcad-profile-preflight', () => ({
  preflightBundledOrcadStartup: async () => {
    order.push('profile-admission')
    return slot.qualified
  },
  forgetBundledOrcadStartupQualification: () => {
    order.push('forget-qualification')
  },
  discardBundledOrcadStartupQualification: async () => {
    order.push('discard-qualification')
  },
  confirmBundledOrcadStartupQualified: async () => {
    order.push('qualified')
  },
  runOrcadProfilePreflight: profileProbe
}))

beforeEach(() => {
  vi.resetModules()
  order.length = 0
  slot.qualified = false
  slot.verdict = 'ok'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

vi.mock('./orcad-native-preflight', () => ({
  runOrcadNativePreflightVerdict: ({ qualified }: { qualified?: boolean }) => {
    order.push(qualified ? 'preflight-qualified' : 'preflight')
    return slot.verdict
  }
}))

vi.mock('./orcad-managed-stop-command', () => ({
  runOrcadManagedStopCommandAndExit: async (argv: string[]) => {
    order.push(`managed-stop:${argv.join(' ')}`)
  }
}))

vi.mock('./orcad-entry', () => ({
  main: vi.fn(async () => {
    order.push('main')
  })
}))

describe('orcad entry', () => {
  it.each([['--help'], ['-h'], ['--json', '--help'], ['--bind', '--help', '-h']])(
    'handles help before startup probes or stdout redirection: %j',
    async (...argv) => {
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['runtime', 'orcad.js', ...argv])
      await import('./main')
      const { main } = await import('./orcad-entry')

      expect(main).toHaveBeenCalledWith(argv)
      expect(order).toEqual(['main'])
      expect(profileProbe).not.toHaveBeenCalled()
      expect(reserveStdout).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['--bind', '--help'],
    ['--pairing-address', '-h'],
    ['--project-root', '--help']
  ])('keeps startup probes when help is consumed as a value: %j', async (...argv) => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['runtime', 'orcad.js', ...argv])
    await import('./main')
    await vi.waitFor(() => expect(order).toContain('qualified'))

    expect(order).toEqual(['profile-admission', 'preflight', 'main', 'qualified'])
    expect(reserveStdout).toHaveBeenCalledOnce()
  })

  it.each([
    { flag: ORCAD_PROFILE_PREFLIGHT_FLAG, nativeFeatures: true },
    { flag: ORCAD_STARTUP_PREFLIGHT_FLAG, nativeFeatures: false }
  ])(
    'runs the selected disposable probe without starting a server: $flag',
    async ({ flag, nativeFeatures }) => {
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['runtime', 'orcad.js', flag, 'nonce'])
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub only records the call; nothing reads its never return.
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      await import('./main')
      expect(profileProbe).toHaveBeenCalledExactlyOnceWith('nonce', { nativeFeatures })
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
      expect(order).toEqual([])
    }
  )

  it('runs the native preflight before starting the runtime, and records qualification after it', async () => {
    await import('./main')
    await vi.waitFor(() => expect(order).toContain('qualified'))

    expect(order).toEqual(['profile-admission', 'preflight', 'main', 'qualified'])
  })

  it('tells the native preflight a qualified slot, so it skips the node-pty probe child', async () => {
    slot.qualified = true
    await import('./main')
    await vi.waitFor(() => expect(order).toContain('qualified'))

    expect(order).toEqual(['profile-admission', 'preflight-qualified', 'main', 'qualified'])
  })

  it('discards the slot qualification when node-pty later fails to load in this process', async () => {
    await import('./main')
    await vi.waitFor(() => expect(order).toContain('qualified'))
    const { reportNodePtyLoadFailure } = await import('../providers/node-pty-load-failure')

    reportNodePtyLoadFailure(new Error('pty.node failed to load'))

    await vi.waitFor(() => expect(order).toContain('discard-qualification'))
  })

  it('drops the qualification when the node-pty probe does not pass cleanly', async () => {
    slot.verdict = 'degraded'
    await import('./main')
    await vi.waitFor(() => expect(order).toContain('main'))

    expect(order.slice(0, 4)).toEqual([
      'profile-admission',
      'preflight',
      'forget-qualification',
      'main'
    ])
  })

  it('records no qualification when startup fails before readiness', async () => {
    const { main } = await import('./orcad-entry')
    vi.mocked(main).mockRejectedValueOnce(new Error('profile open failed'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub only records the call; nothing reads its never return.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await import('./main')
    await vi.waitFor(() => expect(exit).toHaveBeenCalled())

    expect(order).toEqual(['profile-admission', 'preflight'])
  })

  it.each([ORCAD_COMPLETE_MANAGED_STOP_FLAG, ORCAD_CANCEL_MANAGED_STOP_FLAG])(
    'runs %s without preflights, the bundled handoff, or a runtime',
    async (flag) => {
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['runtime', 'orcad.js', flag, '{}'])
      await import('./main')
      await vi.waitFor(() => expect(order).toHaveLength(1))

      expect(order).toEqual([`managed-stop:${flag} {}`])
    }
  )

  it('runs the Windows breakaway launcher without preflights or a runtime', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'runtime',
      'orcad.js',
      '--windows-breakaway-launch',
      '--stdout-file',
      'out',
      '--stderr-file',
      'err',
      '--orcad-args',
      '--json'
    ])
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((_chunk: unknown, callback?: unknown) => {
        if (typeof callback === 'function') {
          callback()
        }
        return true
      })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub only records the call; nothing reads its never return.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    await import('./main')
    await vi.waitFor(() => expect(exit).toHaveBeenCalled())
    expect(String(write.mock.calls[0]?.[0])).toMatch(/^ORCA_ORCAD_LAUNCH /u)
    expect(order).toEqual([])
  })
})
