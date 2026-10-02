import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { applyManagedDataAccountEnvironment } from '../managed-data-accounts/launch-environment'
import {
  probeOpenCodeModelAvailability,
  resolveOpenCodeDirectModelExecutable
} from '../opencode/opencode-model-availability'
import { probeOpenCodeLaunchCapabilities } from '../opencode/opencode-launch-capabilities'
import { resolveLocalProjectRuntimeForRepo } from '../project-runtime-git-options'

vi.mock('../managed-data-accounts/launch-environment', () => ({
  applyManagedDataAccountEnvironment: vi.fn()
}))
vi.mock('../opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: vi.fn()
}))
vi.mock('../opencode/opencode-model-availability', () => ({
  probeOpenCodeModelAvailability: vi.fn(),
  resolveOpenCodeDirectModelExecutable: vi.fn()
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
  it('refuses resume preferences before any workspace or process effects', async () => {
    await expect(
      OrcaRuntimeService.prototype.ensureAgentSession.call(
        {},
        {
          kind: 'explicit',
          worktree: 'id:folder',
          agent: 'opencode',
          providerSession: { key: 'session_id', id: 'ses_resume' },
          launchPreferences: { model: 'opencode/fledge-alpha-free' }
        }
      )
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
  })
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(applyManagedDataAccountEnvironment).mockReset()
    vi.mocked(probeOpenCodeModelAvailability).mockResolvedValue(true)
    vi.mocked(resolveOpenCodeDirectModelExecutable).mockResolvedValue('/tmp/private-opencode')
    vi.mocked(resolveLocalProjectRuntimeForRepo).mockReturnValue(undefined)
    vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
      version: '1.18.30',
      pluginApi: 'v1',
      promptMode: 'submit'
    })
  })
  it('probes a local folder with its configured command and environment', async () => {
    expect(await probe(host())).toBe(true)
    expect(probeOpenCodeLaunchCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/tmp/private-opencode',
        cwd: '/tmp/folder',
        hostIdentity: 'host-1',
        env: expect.objectContaining({ OPENCODE_CONFIG_DIR: '/tmp/private-config' })
      })
    )
  })
  it('uses the same selected account environment for version and catalog probes', async () => {
    vi.mocked(applyManagedDataAccountEnvironment).mockImplementation((env) => {
      env.XDG_DATA_HOME = '/private/selected-account'
      env.OPENCODE_AUTH_CONTENT = ''
      env.OPENCODE_DB = 'opencode.db'
    })
    expect(await probe(host())).toBe(true)
    const env = expect.objectContaining({
      XDG_DATA_HOME: '/private/selected-account',
      OPENCODE_AUTH_CONTENT: '',
      OPENCODE_DB: 'opencode.db'
    })
    expect(probeOpenCodeLaunchCapabilities).toHaveBeenCalledWith(expect.objectContaining({ env }))
    expect(probeOpenCodeModelAvailability).toHaveBeenCalledWith(expect.objectContaining({ env }))
    expect(applyManagedDataAccountEnvironment).toHaveBeenCalledWith(expect.anything(), {
      launchAgent: 'opencode'
    })
  })
  it('refuses unverified legacy versions even when they accept a model flag', async () => {
    vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
      version: '1.1.23',
      pluginApi: 'v1',
      promptMode: 'submit'
    })
    expect(await probe(host())).toBe(false)
    expect(probeOpenCodeModelAvailability).not.toHaveBeenCalled()
  })
  it('refuses creation repo catalogs before the actual destination exists', async () => {
    expect(
      await OrcaRuntimeService.prototype.probeOrchestrationOpenCodeModelLaunchSupport.call(host(), {
        repo: 'id:repo',
        model: 'opencode/fledge-alpha-free'
      })
    ).toBe(false)
    expect(probeOpenCodeLaunchCapabilities).not.toHaveBeenCalled()
    expect(probeOpenCodeModelAvailability).not.toHaveBeenCalled()
  })
  it('rejects an unknown selector rather than claiming the fallback model', async () => {
    vi.mocked(probeOpenCodeModelAvailability).mockResolvedValue(false)
    expect(await probe(host())).toBe(false)
  })
  it.each(['v2', 'unknown'] as const)('refuses %s CLI model selection', async (pluginApi) => {
    vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
      version: null,
      pluginApi,
      promptMode: 'unknown'
    })
    expect(await probe(host())).toBe(false)
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
  it('refuses WSL until the actual guest launch environment is supported', async () => {
    expect(await probe(host({ path: '\\\\wsl.localhost\\Ubuntu\\home\\repo' }))).toBe(false)
    expect(probeOpenCodeLaunchCapabilities).not.toHaveBeenCalled()
  })
})
