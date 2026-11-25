import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { withOmpDraftCleanup } from '../../shared/agent-launch/startup/omp-draft-launch'
import { withFreshOmpLaunch } from '../../shared/agent-launch/startup/omp-fresh-launch'
import type { readHostManagedAgentCommands } from '../runtime/rpc/methods/host-management/managed-copy-detection'
import { alignManagedAgentLaunchAtSpawn } from './managed-agent-spawn-program'

vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/data/orca'
}))
const host = vi.hoisted(() => ({
  resolve: vi.fn<typeof readHostManagedAgentCommands>(),
  capture: vi.fn(async () => ({ PATH: '/profile/bin:/usr/bin' })),
  cached: vi.fn(async (): Promise<{ status: 'captured' | 'fallback'; env: NodeJS.ProcessEnv }> => ({
    status: 'fallback',
    env: {}
  }))
}))
vi.mock(
  import('../runtime/rpc/methods/host-management/managed-copy-detection'),
  async (importOriginal) => {
    const actual = await importOriginal()
    host.resolve.mockImplementation(actual.readHostManagedAgentCommands)
    return { ...actual, readHostManagedAgentCommands: host.resolve }
  }
)

vi.mock('../startup/shell-environment/login-shell-environment', () => ({
  resolveLoginShellEnvironment: host.capture,
  captureLoginShellEnvironment: host.cached
}))

const ompGuard = 'printenv ORCA_OMP_FRESH_CONFIG >/dev/null && test -f "$ORCA_OMP_FRESH_CONFIG"'
const ompFailure =
  "printf '%s\\n' 'Orca: fresh OMP settings are unavailable on this host. Restart the terminal after updating Orca.' >&2"

const spawn = (launchCommand: string) =>
  alignManagedAgentLaunchAtSpawn({ launchCommand, getSettings: () => ({}) }, 'posix')

it.runIf(process.platform === 'win32')(
  'uses the absolute Codex path in PowerShell when its directory is quoted on PATH',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca codex path '))
    const bin = join(dir, 'codex.exe')
    try {
      writeFileSync(bin, '')
      expect(
        await alignManagedAgentLaunchAtSpawn(
          { launchCommand: 'codex --verbose', queuedPath: `"${dir}"`, getSettings: () => ({}) },
          'powershell'
        )
      ).toBe(`& '${bin}' --verbose`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it('prepares the executable before re-rendering the guarded OMP invocation', async () => {
  host.resolve.mockResolvedValue({ omp: '/current/omp' })
  const guard = `${ompGuard} || ${ompFailure}; ${ompGuard} && `
  const suffix = ` --config "$ORCA_OMP_FRESH_CONFIG" 'prompt'`
  expect(await spawn(`${guard}omp${suffix}`)).toBe(`${guard}'/current/omp'${suffix}`)
  expect(await spawn(withOmpDraftCleanup(`${guard}omp${suffix}`, 'posix'))).toBe(
    withOmpDraftCleanup(`${guard}'/current/omp'${suffix}`, 'posix')
  )
})

it('resolves the program inside a legacy cmd OMP guard', async () => {
  host.resolve.mockResolvedValue({ omp: 'C:\\current\\omp.exe' })
  const guard = 'if exist "%ORCA_OMP_FRESH_CONFIG%" (if not exist "%ORCA_OMP_FRESH_CONFIG%\\*" ('
  const failure =
    'echo Orca: fresh OMP settings are unavailable on this host. Restart the terminal after updating Orca. 1>&2 & verify invalid 2>nul'
  const suffix = ` --config "%ORCA_OMP_FRESH_CONFIG%") else (${failure})) else (${failure})`
  expect(
    await alignManagedAgentLaunchAtSpawn(
      {
        launchCommand: `${guard}omp${suffix}`,
        queuedPath: 'C:\\tools',
        getSettings: () => ({})
      },
      'cmd'
    )
  ).toBe(`${guard}"C:\\current\\omp.exe"${suffix}`)
})

it('resolves the OMP executable without imposing the launch prefix limit on a prompt', async () => {
  host.resolve.mockResolvedValue({ omp: '/current/omp' })
  const guard = `${ompGuard} || ${ompFailure}; ${ompGuard} && `
  const prompt = ` '${'x'.repeat(5_000)}'`
  const command = withFreshOmpLaunch('omp', 'posix', prompt)
  expect(await spawn(command)).toBe(
    `${guard}'/current/omp' --config "$ORCA_OMP_FRESH_CONFIG"${prompt}`
  )
})

it.skipIf(process.platform === 'win32')(
  'lets a CLI that shell startup files put on PATH win a queued launch with a PATH seed',
  async () => {
    const custom = mkdtempSync(join(tmpdir(), 'orca-zshrc-bin-'))
    try {
      writeFileSync(join(custom, 'codex'), '', { mode: 0o755 })
      const managed = '/data/orca/agent-runtimes/codex/2.0/bin/codex'
      // Orca's copy stands in only when no folder on the searched PATH holds the user's codex.
      host.resolve.mockImplementation(
        async (_settings, _agents, options): Promise<Record<string, string>> => {
          return (options?.pathEnv ?? '').split(':').some((dir: string) => {
            try {
              return statSync(join(dir, 'codex')).isFile()
            } catch {
              return false
            }
          })
            ? {}
            : { codex: managed }
        }
      )
      const queued = () =>
        alignManagedAgentLaunchAtSpawn(
          { launchCommand: 'codex --verbose', queuedPath: '/seed/bin', getSettings: () => ({}) },
          'posix'
        )
      expect(await queued()).toBe(`'${managed}' --verbose`)
      // .zshrc put the folder on the cached login PATH.
      host.cached.mockResolvedValue({ status: 'captured', env: { PATH: `${custom}:/usr/bin` } })
      expect(await queued()).toBe('codex --verbose')
    } finally {
      host.cached.mockResolvedValue({ status: 'fallback', env: {} })
      rmSync(custom, { recursive: true, force: true })
    }
  }
)
