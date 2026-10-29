import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureBackfill: vi.fn(async () => {}),
  blockedPath: vi.fn(async (): Promise<{ distro: string; state: string } | null> => null)
}))

// The common single-distro setup: a null distro resolves to this default.
vi.mock('../../wsl', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWslDistrosAsync: async () => ['Ubuntu']
}))
vi.mock('../../codex/codex-state-db-backfill-recovery', () => ({
  ensureCodexStateDbBackfillRecoveryStarted: mocks.ensureBackfill
}))
vi.mock('../../wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  blockedWslDistroForPath: mocks.blockedPath
}))

import { resolvePtySpawnHostEnv } from './spawn-host-env'
import { noCodexResumeLaunch, stripSequencedStartupResumeArgv } from './host-env/codex-resume'
import { isWslUserActFor } from '../../wsl/wsl-user-act-scope'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import type { CodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'

const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function resolve(
  wslPassiveRestore: boolean,
  seen: boolean[],
  launch: { target?: CodexAccountSelectionTarget; expectedWslDistro?: string | null } = {}
) {
  return resolvePtySpawnHostEnv({
    launchAgent: 'codex',
    command: 'codex',
    resumeProviderSession: undefined,
    env: {},
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo',
    shellOverride: undefined,
    expectedWslDistro: launch.expectedWslDistro === undefined ? 'Ubuntu' : launch.expectedWslDistro,
    codexSelectionTarget: launch.target ?? { runtime: 'wsl', wslDistro: 'Ubuntu' },
    preAdopted: false,
    isDaemonHostSpawn: false,
    sessionId: 'session-1',
    callerNamedSession: true,
    mintedSessionId: false,
    resumeOnSelectedAccount: false,
    emptySessionIdSkipsHostEnv: false,
    wslPassiveRestore,
    requestedAgentTeamsPath: undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a non-daemon spawn returns before any provider call.
    provider: {} as IPtyProvider,
    deps: {
      prepareCodexResumeHome: () => null,
      resolveCodexResumeLaunch: async () => noCodexResumeLaunch('codex'),
      noCodexResumeLaunch,
      reconcileSharedRuntimeResumeHome: async (home) => home.codexHomePath,
      stripSequencedStartupResumeArgv,
      getSelectedCodexHomePath: async () => {
        seen.push(isWslUserActFor('Ubuntu'))
        return HOME
      }
    }
  })
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  mocks.ensureBackfill.mockClear()
  mocks.blockedPath.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

// Spawn env prep runs before #35813's hold: only a launch someone asked for may start the distro (E9).
describe('WSL spawn host env', () => {
  it('runs a launch someone asked for as a user act on its distro', async () => {
    const seen: boolean[] = []
    await resolve(false, seen)
    expect(seen).toEqual([true])
  })

  it('runs a passive restore outside any user act, so its prep is gated', async () => {
    const seen: boolean[] = []
    await resolve(true, seen)
    expect(seen).toEqual([false])
  })

  it('never turns a passive restore with no named distro into a user act on the default one', async () => {
    const seen: boolean[] = []
    await resolve(true, seen, {
      target: { runtime: 'wsl', wslDistro: null },
      expectedWslDistro: null
    })
    expect(seen).toEqual([false])
  })

  it('never turns a host-target spawn into a user act on the default distro', async () => {
    const seen: boolean[] = []
    await resolve(false, seen, { target: { runtime: 'host' }, expectedWslDistro: null })
    expect(seen).toEqual([false])
  })

  it('a WSL launch someone asked for, with no named distro, acts on the default one', async () => {
    const seen: boolean[] = []
    await resolve(false, seen, {
      target: { runtime: 'wsl', wslDistro: null },
      expectedWslDistro: null
    })
    expect(seen).toEqual([true])
  })

  it('skips the state-DB recovery (a UNC read) when the distro is stopped', async () => {
    mocks.blockedPath.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
    await resolve(true, [])
    expect(mocks.blockedPath).toHaveBeenCalledWith(HOME)
    expect(mocks.ensureBackfill).not.toHaveBeenCalled()
  })

  it('still starts the state-DB recovery when the distro runs', async () => {
    await resolve(true, [])
    expect(mocks.ensureBackfill).toHaveBeenCalledWith(HOME)
  })
})
