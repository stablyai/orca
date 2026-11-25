import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { withOmpDraftCleanup } from '../../shared/agent-launch/startup/omp-draft-launch'
import { withFreshOmpLaunch } from '../../shared/agent-launch/startup/omp-fresh-launch'
import type { readHostManagedAgentCommands } from '../runtime/rpc/methods/host-management/managed-copy-detection'
import { rememberManagedAgentRelease } from './managed-agent-cli-registry'
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

const settings: { agentCmdOverrides?: Record<string, string> } = {}
const spawn = (launchCommand: string, codexRuntime: 'host' | 'wsl' = 'host') =>
  alignManagedAgentLaunchAtSpawn(
    { launchCommand, codexRuntime, getSettings: () => settings },
    'posix'
  )

it.runIf(process.platform === 'win32')(
  'uses the absolute Claude path in PowerShell when its directory is quoted on PATH',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca claude path '))
    const bin = join(dir, 'claude.exe')
    try {
      writeFileSync(bin, '')
      expect(
        await alignManagedAgentLaunchAtSpawn(
          { launchCommand: 'claude --verbose', queuedPath: `"${dir}"`, getSettings: () => ({}) },
          'powershell'
        )
      ).toBe(`& '${bin}' --verbose`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  "starts the installed release of Orca's copy, or the plain name where it can't run",
  async () => {
    rememberManagedAgentRelease('claude', '/data/orca/agent-runtimes/claude/2.0')
    host.resolve.mockResolvedValue({ claude: '/data/orca/agent-runtimes/claude/2.0/claude' })
    expect(
      await spawn("cd '/w' && '/data/orca/agent-runtimes/claude/1.0/claude' --resume abc")
    ).toBe("cd '/w' && '/data/orca/agent-runtimes/claude/2.0/claude' --resume abc")
    expect(await spawn("'/data/orca/agent-runtimes/claude/1.0/claude' --x", 'wsl')).toBe(
      'claude --x'
    )
    expect(await spawn('claude --x')).toBe("'/data/orca/agent-runtimes/claude/2.0/claude' --x")
    expect(await spawn("cd '/w' && claude --resume abc")).toBe(
      "cd '/w' && '/data/orca/agent-runtimes/claude/2.0/claude' --resume abc"
    )
    expect(await spawn('codex --x')).toBe('codex --x')
    // Only the program moves: prompts and other programs' arguments keep the text they hold.
    expect(
      await spawn("claude 'read /data/orca/agent-runtimes/claude/1.0/claude; then claude'")
    ).toBe(
      "'/data/orca/agent-runtimes/claude/2.0/claude' 'read /data/orca/agent-runtimes/claude/1.0/claude; then claude'"
    )
    expect(await spawn("rm -rf '/data/orca/agent-runtimes/claude/1.0'")).toBe(
      "rm -rf '/data/orca/agent-runtimes/claude/1.0'"
    )
    host.resolve.mockResolvedValue({ claude: '/profile/bin/claude' })
    expect(
      await spawn("cd /w&&env DEBUG=1 '/data/orca/agent-runtimes/claude/1.0/claude' --x")
    ).toBe("cd /w&&env DEBUG=1 '/profile/bin/claude' --x")
    expect(host.resolve).toHaveBeenLastCalledWith(settings, ['claude'], {
      pathEnv: '/profile/bin:/usr/bin',
      shell: 'posix',
      forDelivery: true
    })
    host.resolve.mockClear()
    host.capture.mockClear()
    expect(await spawn("/bin/sh -c 'claude --verbose'")).toBe("/bin/sh -c 'claude --verbose'")
    expect(await spawn("echo '&&' claude")).toBe("echo '&&' claude")
    expect(await spawn('')).toBe('')
    expect(host.resolve).not.toHaveBeenCalled()
    expect(host.capture).not.toHaveBeenCalled()
    settings.agentCmdOverrides = { claude: '/data/orca/agent-runtimes/claude/1.0/claude' }
    expect(await spawn("'/data/orca/agent-runtimes/claude/1.0/claude' --x")).toBe(
      "'/data/orca/agent-runtimes/claude/1.0/claude' --x"
    )
    settings.agentCmdOverrides = undefined
    rememberManagedAgentRelease('claude', null)
    host.resolve.mockResolvedValue({})
    expect(await spawn("cd '/w' && '/data/orca/agent-runtimes/claude/1.0/claude' --x")).toBe(
      "cd '/w' && claude --x"
    )
    expect(await spawn("sh -c 'exec /data/orca/agent-runtimes/claude/1.0/claude auth login'")).toBe(
      "sh -c 'exec /data/orca/agent-runtimes/claude/1.0/claude auth login'"
    )
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
        getSettings: () => settings
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
    const inherited = process.env.PATH
    try {
      writeFileSync(join(custom, 'claude'), '', { mode: 0o755 })
      const managed = '/data/orca/agent-runtimes/claude/2.0/claude'
      // Orca's copy stands in only when no folder on the searched PATH holds the user's claude.
      host.resolve.mockImplementation(
        async (_settings, _agents, options): Promise<Record<string, string>> => {
          return (options?.pathEnv ?? '').split(':').some((dir: string) => {
            try {
              return statSync(join(dir, 'claude')).isFile()
            } catch {
              return false
            }
          })
            ? {}
            : { claude: managed }
        }
      )
      const queued = () =>
        alignManagedAgentLaunchAtSpawn(
          { launchCommand: 'claude --verbose', queuedPath: '/seed/bin', getSettings: () => ({}) },
          'posix'
        )
      expect(await queued()).toBe(`'${managed}' --verbose`)
      // .zshrc put the folder on the cached login PATH; packaged Orca also merges it into its own PATH.
      host.cached.mockResolvedValue({ status: 'captured', env: { PATH: `${custom}:/usr/bin` } })
      process.env.PATH = `${custom}:${inherited}`
      expect(await queued()).toBe('claude --verbose')
    } finally {
      process.env.PATH = inherited
      host.cached.mockResolvedValue({ status: 'fallback', env: {} })
      rmSync(custom, { recursive: true, force: true })
    }
  }
)
