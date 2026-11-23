import { expect, it, vi } from 'vitest'
import { withOmpDraftCleanup } from '../../shared/agent-launch/startup/omp-draft-launch'
import { rememberManagedAgentRelease } from './managed-agent-cli-registry'
import { alignManagedAgentLaunchAtSpawn } from './managed-agent-spawn-program'

vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/data/orca'
}))
const host = vi.hoisted(() => ({
  resolve: vi.fn<() => Promise<Record<string, string>>>(),
  capture: vi.fn(async () => ({ PATH: '/profile/bin:/usr/bin' }))
}))
vi.mock('../runtime/rpc/methods/host-management/managed-copy-detection', () => ({
  readHostManagedAgentCommands: host.resolve
}))

vi.mock('../startup/shell-environment/login-shell-environment', () => ({
  resolveLoginShellEnvironment: host.capture
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
