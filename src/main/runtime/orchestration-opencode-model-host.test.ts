import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { resolveOpenCodeDirectModelExecutable } from '../opencode/opencode-model-executable'
import { probeOpenCodeLaunchCapabilities } from '../opencode/opencode-launch-capabilities'
import { resolveLocalProjectRuntimeForRepo } from '../project-runtime-git-options'
import { OPENCODE_MODEL_VERSION_REFUSAL } from '../../shared/agent-launch-model-preferences'

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
  it('checks only the version route for a model in a local folder', async () => {
    expect(await probe(host())).toBe(true)
    expect(probeOpenCodeLaunchCapabilities).toHaveBeenCalledExactlyOnceWith({
      command: '/tmp/private-opencode',
      agent: 'opencode',
      cwd: '/tmp/folder',
      env: expect.objectContaining({ OPENCODE_CONFIG_DIR: '/tmp/private-config' }),
      hostIdentity: 'host-1'
    })
    expect(resolveOpenCodeDirectModelExecutable).not.toHaveBeenCalled()
  })
  it('refuses an unsafe version before model discovery or worker creation', async () => {
    vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
      version: '2.0.14',
      pluginApi: 'v2',
      promptMode: 'unknown'
    })
    await expect(probe(host())).rejects.toMatchObject({
      code: 'capability_unsupported',
      message: OPENCODE_MODEL_VERSION_REFUSAL
    })
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
