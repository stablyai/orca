import { expect, it, vi } from 'vitest'
import { rememberManagedAgentRelease } from './managed-agent-cli-registry'
import { alignManagedAgentLaunchAtSpawn } from './managed-agent-spawn-program'

vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/data/orca'
}))
vi.mock('../runtime/rpc/methods/host-management/managed-copy-detection', () => ({
  readHostManagedAgentCommands: async (_settings: unknown, agents: string[]) =>
    agents.includes('claude') ? { claude: '/data/orca/agent-runtimes/claude/2.0/claude' } : {}
}))

const spawn = (launchCommand: string, codexRuntime: 'host' | 'wsl' = 'host') =>
  alignManagedAgentLaunchAtSpawn({ launchCommand, codexRuntime, getSettings: () => ({}) }, 'posix')

it.skipIf(process.platform === 'win32')(
  "starts the installed release of Orca's copy, or the plain name where it can't run",
  async () => {
    rememberManagedAgentRelease('claude', '/data/orca/agent-runtimes/claude/2.0')
    expect(
      await spawn("cd '/w' && '/data/orca/agent-runtimes/claude/1.0/claude' --resume abc")
    ).toBe("cd '/w' && '/data/orca/agent-runtimes/claude/2.0/claude' --resume abc")
    expect(await spawn("'/data/orca/agent-runtimes/claude/1.0/claude' --x", 'wsl')).toBe(
      'claude --x'
    )
    expect(await spawn('claude --x')).toBe("'/data/orca/agent-runtimes/claude/2.0/claude' --x")
    expect(await spawn('codex --x')).toBe('codex --x')
    rememberManagedAgentRelease('claude', null)
    expect(await spawn("'/data/orca/agent-runtimes/claude/1.0/claude' --x")).toBe('claude --x')
  }
)
