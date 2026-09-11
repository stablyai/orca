import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  rankAiVaultSessionsWithModel,
  resolveAiVaultSessionSearchGenerationParams,
  resolveAiVaultSessionSearchGenerationTarget
} from './session-ai-rerank'

vi.mock('../text-generation/commit-message-text-generation', () => ({
  resolveBranchNameGenerationParams: vi.fn(),
  generateTextFromPrompt: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('../wsl', () => ({
  parseWslPath: vi.fn(() => null)
}))

const { resolveBranchNameGenerationParams, generateTextFromPrompt } =
  await import('../text-generation/commit-message-text-generation')
const { getSshGitProvider } = await import('../providers/ssh-git-dispatch')
const { parseWslPath } = await import('../wsl')

const resolveMock = vi.mocked(resolveBranchNameGenerationParams)
const generateMock = vi.mocked(generateTextFromPrompt)
const getSshGitProviderMock = vi.mocked(getSshGitProvider)
const parseWslPathMock = vi.mocked(parseWslPath)

const cards = [
  {
    id: 'claude:1',
    title: 'Linux pairing',
    agent: 'claude',
    cwd: '/repo',
    branch: 'fix',
    model: 'sonnet',
    preview: 'pairing flakes'
  },
  {
    id: 'codex:2',
    title: 'Wizard',
    agent: 'codex',
    cwd: '/repo',
    branch: 'main',
    model: 'gpt',
    preview: 'onboarding'
  }
]

describe('rankAiVaultSessionsWithModel', () => {
  beforeEach(() => {
    resolveMock.mockReset()
    generateMock.mockReset()
    getSshGitProviderMock.mockReset()
    parseWslPathMock.mockReset()
    parseWslPathMock.mockReturnValue(null)
  })

  it('reranks with the branchName auto-rename generation params', async () => {
    resolveMock.mockReturnValue({
      ok: true,
      params: {
        agentId: 'claude',
        model: 'claude-sonnet-4-5'
      }
    })
    generateMock.mockResolvedValue({
      success: true,
      message: '["codex:2","claude:1"]',
      agentLabel: 'Claude'
    })

    await expect(
      rankAiVaultSessionsWithModel({ query: 'onboarding wizard', cards }, {} as GlobalSettings, {
        path: '/repo',
        connectionId: null,
        sourceControlAi: { customAgentCommand: 'repo-agent {prompt}' }
      })
    ).resolves.toEqual({
      ok: true,
      rankedIds: ['codex:2', 'claude:1'],
      usedModel: true,
      agentLabel: 'Claude'
    })
    expect(resolveMock).toHaveBeenCalledWith(
      expect.anything(),
      'local',
      expect.objectContaining({ sourceControlAi: { customAgentCommand: 'repo-agent {prompt}' } })
    )
    expect(generateMock).toHaveBeenCalledOnce()
    expect(generateMock.mock.calls[0]?.[2]).toMatchObject({ kind: 'local' })
  })

  it('reranks through the SSH remote generation target', async () => {
    const execute = vi.fn()
    getSshGitProviderMock.mockReturnValue({
      executeCommitMessagePlan: execute
    } as never)
    resolveMock.mockReturnValue({
      ok: true,
      params: { agentId: 'claude', model: 'claude-sonnet-4-5' }
    })
    generateMock.mockResolvedValue({
      success: true,
      message: '["codex:2"]',
      agentLabel: 'Claude'
    })

    await rankAiVaultSessionsWithModel(
      { query: 'onboarding wizard', cards },
      {} as GlobalSettings,
      {
        path: '/remote/repo',
        connectionId: 'ssh-1',
        sourceControlAi: { customAgentCommand: 'repo-agent {prompt}' }
      }
    )

    expect(generateMock.mock.calls[0]?.[2]).toMatchObject({
      kind: 'remote',
      cwd: '/remote/repo',
      missingBinaryLocation: 'remote PATH'
    })
    const target = generateMock.mock.calls[0]?.[2] as {
      execute?: (plan: unknown, cwd: string, timeoutMs: number, operation: string) => unknown
    }
    target.execute?.({ kind: 'probe' }, '/remote/repo', 1000, 'session-history-search')
    expect(execute).toHaveBeenCalledWith(
      { kind: 'probe' },
      '/remote/repo',
      1000,
      'session-history-search'
    )
  })

  it('forwards the WSL distro on the local generation target', async () => {
    resolveMock.mockReturnValue({
      ok: true,
      params: { agentId: 'claude', model: 'claude-sonnet-4-5' }
    })
    generateMock.mockResolvedValue({
      success: true,
      message: '["claude:1"]',
      agentLabel: 'Claude'
    })

    await rankAiVaultSessionsWithModel(
      { query: 'pairing', cards },
      {} as GlobalSettings,
      { path: 'C:\\repo', connectionId: null, sourceControlAi: {} },
      { wslDistro: 'Ubuntu' }
    )

    expect(generateMock.mock.calls[0]?.[2]).toEqual({
      kind: 'local',
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu'
    })
  })

  it('keeps lexical order when the SSH provider is missing', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)
    resolveMock.mockReturnValue({
      ok: true,
      params: { agentId: 'claude', model: 'claude-sonnet-4-5' }
    })

    await expect(
      rankAiVaultSessionsWithModel({ query: 'pairing', cards }, {} as GlobalSettings, {
        path: '/remote/repo',
        connectionId: 'ssh-1',
        sourceControlAi: {}
      })
    ).resolves.toEqual({
      ok: true,
      rankedIds: ['claude:1', 'codex:2'],
      usedModel: false
    })
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('falls back to lexical order when branchName rename AI is not configured', async () => {
    resolveMock.mockReturnValue({ ok: false, error: 'Choose an agent' })

    await expect(
      rankAiVaultSessionsWithModel({ query: 'pairing', cards }, {} as GlobalSettings)
    ).resolves.toEqual({
      ok: true,
      rankedIds: ['claude:1', 'codex:2'],
      usedModel: false
    })
    expect(generateMock).not.toHaveBeenCalled()
  })
})

describe('resolveAiVaultSessionSearchGenerationTarget', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    parseWslPathMock.mockReset()
    parseWslPathMock.mockReturnValue(null)
  })

  it('does not fall back to a local target when the SSH provider is missing', () => {
    getSshGitProviderMock.mockReturnValue(undefined)
    expect(
      resolveAiVaultSessionSearchGenerationTarget({
        path: '/remote/repo',
        connectionId: 'ssh-1',
        sourceControlAi: {}
      })
    ).toBeNull()
  })

  it('reads the WSL distro from a UNC repo path when IPC does not supply one', () => {
    parseWslPathMock.mockReturnValue({ distro: 'Ubuntu', linuxPath: '/home/me/repo' })
    expect(
      resolveAiVaultSessionSearchGenerationTarget({
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        connectionId: null,
        sourceControlAi: {}
      })
    ).toEqual({
      kind: 'local',
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
      wslDistro: 'Ubuntu'
    })
  })
})

describe('resolveAiVaultSessionSearchGenerationParams', () => {
  it('delegates to the shared branchName generation helper', () => {
    resolveMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4' }
    })
    const settings = {} as GlobalSettings
    const repo = { connectionId: 'ssh-1', sourceControlAi: { enabled: true } }

    expect(resolveAiVaultSessionSearchGenerationParams(settings, repo)).toEqual({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4' }
    })
    expect(resolveMock).toHaveBeenCalledWith(settings, 'ssh:ssh-1', repo)
  })
})
