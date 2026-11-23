import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { withOmpDraftCleanup } from '../../shared/agent-launch/startup/omp-draft-launch'
import { withFreshOmpLaunch } from '../../shared/agent-launch/startup/omp-fresh-launch'
import { rememberManagedAgentRelease } from './managed-agent-cli-registry'
import { alignManagedAgentLaunchAtSpawn } from './managed-agent-spawn-program'

vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/data/orca'
}))
const host = vi.hoisted(() => ({
  resolve:
    vi.fn<
      (
        settings: unknown,
        agents: unknown,
        options?: { pathEnv?: string }
      ) => Promise<Record<string, string>>
    >(),
  capture: vi.fn(async () => ({ PATH: '/profile/bin:/usr/bin' })),
  cached: vi.fn(async (): Promise<{ status: 'captured' | 'fallback'; env: NodeJS.ProcessEnv }> => ({
    status: 'fallback',
    env: {}
  }))
}))
vi.mock('../runtime/rpc/methods/host-management/managed-copy-detection', () => ({
  readHostManagedAgentCommands: host.resolve
}))

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
      // .zshrc prepended the folder ahead of the inherited PATH in the cached login capture.
      host.cached.mockResolvedValue({
        status: 'captured',
        env: { PATH: `${custom}:${process.env.PATH}` }
      })
      expect(await queued()).toBe('claude --verbose')
    } finally {
      host.cached.mockResolvedValue({ status: 'fallback', env: {} })
      rmSync(custom, { recursive: true, force: true })
    }
  }
)
