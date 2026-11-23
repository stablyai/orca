import { expect, it, vi } from 'vitest'
import { rememberManagedAgentRelease } from './managed-agent-cli-registry'
import { alignManagedAgentLaunchAtSpawn } from './managed-agent-spawn-program'

vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/data/orca'
}))
const host = vi.hoisted((): { paths: Record<string, string> } => ({ paths: {} }))
vi.mock('../runtime/rpc/methods/host-management/managed-copy-detection', () => ({
  readHostManagedAgentCommands: async () => host.paths
}))

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
    host.paths = { claude: '/data/orca/agent-runtimes/claude/2.0/claude' }
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
    settings.agentCmdOverrides = { claude: '/data/orca/agent-runtimes/claude/1.0/claude' }
    expect(await spawn("'/data/orca/agent-runtimes/claude/1.0/claude' --x")).toBe(
      "'/data/orca/agent-runtimes/claude/1.0/claude' --x"
    )
    settings.agentCmdOverrides = undefined
    rememberManagedAgentRelease('claude', null)
    host.paths = {}
    expect(await spawn("cd '/w' && '/data/orca/agent-runtimes/claude/1.0/claude' --x")).toBe(
      "cd '/w' && claude --x"
    )
    expect(await spawn("sh -c 'exec /data/orca/agent-runtimes/claude/1.0/claude auth login'")).toBe(
      "sh -c 'exec claude auth login'"
    )
  }
)
