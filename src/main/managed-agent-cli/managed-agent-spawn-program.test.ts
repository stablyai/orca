import { expect, it, vi } from 'vitest'
import { rememberManagedAgentRelease } from './managed-agent-cli-registry'
import { managedAgentProgramAtSpawn } from './managed-agent-spawn-program'

vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/data/orca'
}))

it.skipIf(process.platform === 'win32')(
  "starts Orca's installed release for an earlier one, and the stock name once it can't run",
  () => {
    const earlier = '/data/orca/agent-runtimes/claude/1.0/claude'
    rememberManagedAgentRelease('claude', '/data/orca/agent-runtimes/claude/2.0')
    expect(managedAgentProgramAtSpawn(earlier, { wsl: false })).toBe(
      '/data/orca/agent-runtimes/claude/2.0/claude'
    )
    expect(managedAgentProgramAtSpawn(earlier, { wsl: true })).toBe('claude')
    rememberManagedAgentRelease('claude', null)
    expect(managedAgentProgramAtSpawn(earlier, { wsl: false })).toBe('claude')
    expect(managedAgentProgramAtSpawn('/usr/local/bin/claude', { wsl: false })).toBeNull()
    expect(managedAgentProgramAtSpawn('claude', { wsl: false })).toBeNull()
  }
)
