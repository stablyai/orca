import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { resolveOpenCodeDirectModelExecutable } from '../opencode/opencode-model-executable'
import { probeOpenCodeLaunchCapabilities } from '../opencode/opencode-launch-capabilities'
import { resolveLocalProjectRuntimeForRepo } from '../project-runtime-git-options'

vi.mock('../opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: vi.fn()
}))
vi.mock('../opencode/opencode-model-executable', () => ({
  resolveOpenCodeDirectModelExecutable: vi.fn()
}))
vi.mock('../managed-data-accounts/launch-environment', () => ({
  applyManagedDataAccountEnvironment: vi.fn()
}))
vi.mock('../project-runtime-git-options', () => ({ resolveLocalProjectRuntimeForRepo: vi.fn() }))

function host(
  scope: { path: string; connectionId?: string; repo?: { executionHostId?: string } } = {
    path: '/tmp/folder'
  }
) {
  return {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => scope),
    resolveRepoSelector: vi.fn(async () => scope),
    requireStore: () => ({
      getSettings: () => ({
        agentCmdOverrides: { opencode: '/tmp/private-opencode' },
        agentDefaultEnv: { opencode: { OPENCODE_CONFIG_DIR: '/tmp/private-config' } }
      })
    }),
    getRuntimeId: () => 'host-1'
  }
}
function probe(
  runtime: ReturnType<typeof host>,
  target = { worktree: 'id:folder', model: 'opencode/fledge-alpha-free' }
) {
  return OrcaRuntimeService.prototype.probeOrchestrationOpenCodeModelLaunchSupport.call(
    runtime,
    target
  )
}

describe('OpenCode worker model execution host', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveOpenCodeDirectModelExecutable).mockResolvedValue('/tmp/private-opencode')
    vi.mocked(resolveLocalProjectRuntimeForRepo).mockReturnValue(undefined)
    vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
      version: '1.18.30',
      pluginApi: 'v1',
      promptMode: 'submit'
    })
  })
  it('accepts a model in a local folder without executing the CLI', async () => {
    expect(await probe(host())).toBe(true)
    expect(probeOpenCodeLaunchCapabilities).not.toHaveBeenCalled()
    expect(resolveOpenCodeDirectModelExecutable).not.toHaveBeenCalled()
  })
  it('never probes the client executable for an SSH workspace', async () => {
    expect(await probe(host({ path: '/remote/folder', connectionId: 'ssh-1' }))).toBe(false)
    expect(probeOpenCodeLaunchCapabilities).not.toHaveBeenCalled()
  })
  it('never probes the client executable for a foreign execution host', async () => {
    expect(
      await probe(host({ path: '/remote/folder', repo: { executionHostId: 'remote-host' } }))
    ).toBe(false)
    expect(probeOpenCodeLaunchCapabilities).not.toHaveBeenCalled()
  })
  it('refuses WSL without probing a different profile', async () => {
    expect(await probe(host({ path: '\\\\wsl.localhost\\Ubuntu\\home\\repo' }))).toBe(false)
    expect(probeOpenCodeLaunchCapabilities).not.toHaveBeenCalled()
  })
})
