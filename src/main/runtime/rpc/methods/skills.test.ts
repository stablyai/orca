import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'

vi.mock('electron', () => ({
  app: { getPath: () => '/orca-state', isPackaged: true }
}))

vi.mock('../../../skills/skill-discovery-target', () => ({
  resolveSkillDiscoveryTarget: vi.fn((target) => ({ kind: 'native-host', cwd: target?.cwd })),
  discoverSkillsOnTarget: vi.fn(async () => ({ skills: [], sources: [], scannedAt: 1 }))
}))
import { SKILL_METHODS } from './skills'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../../../skills/skill-discovery-target'

const WSL_RUNTIME = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'project-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'wsl:Ubuntu'
  }
} as const

function makeContext(overrides: {
  resolveProjectRuntimeForWorktree?: (worktreeId: string | null | undefined) => unknown
}): RpcContext {
  return {
    runtime: {
      listRepos: () => [],
      resolveSkillDiscoveryProviderRoots: async () => ({}),
      resolveProjectRuntimeForWorktree:
        overrides.resolveProjectRuntimeForWorktree ?? (() => undefined)
    }
  } as unknown as RpcContext
}

function discoverMethod() {
  const method = SKILL_METHODS.find((entry) => entry.name === 'skills.discover')
  if (!method) {
    throw new Error('skills.discover method not registered')
  }
  return method
}

function installMethod() {
  const method = SKILL_METHODS.find((entry) => entry.name === 'skills.install')
  if (!method) {
    throw new Error('skills.install method not registered')
  }
  return method
}

function method(name: string) {
  const value = SKILL_METHODS.find((entry) => entry.name === name)
  if (!value) {
    throw new Error(`${name} method not registered`)
  }
  return value
}

describe('skills.discover RPC', () => {
  it('resolves the project runtime from the owning runtime store when the caller omits it', async () => {
    const resolveProjectRuntimeForWorktree = vi.fn(() => WSL_RUNTIME)
    await discoverMethod().handler(
      { cwd: 'C:\\repo', worktreeId: 'worktree-1' },
      makeContext({ resolveProjectRuntimeForWorktree })
    )
    expect(resolveProjectRuntimeForWorktree).toHaveBeenCalledWith('worktree-1')
    expect(vi.mocked(resolveSkillDiscoveryTarget)).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectRuntime: WSL_RUNTIME })
    )
  })

  it('prefers a caller-supplied project runtime over store resolution', async () => {
    const resolveProjectRuntimeForWorktree = vi.fn()
    await discoverMethod().handler(
      { cwd: '/repo', worktreeId: 'worktree-1', projectRuntime: WSL_RUNTIME },
      makeContext({ resolveProjectRuntimeForWorktree })
    )
    expect(resolveProjectRuntimeForWorktree).not.toHaveBeenCalled()
    expect(vi.mocked(resolveSkillDiscoveryTarget)).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectRuntime: WSL_RUNTIME })
    )
  })

  it('only bypasses the host scan cache when the caller asks for a refresh', async () => {
    await discoverMethod().handler({ cwd: '/repo' }, makeContext({}))
    expect(vi.mocked(discoverSkillsOnTarget)).toHaveBeenLastCalledWith(expect.anything(), [], {
      providerRootOverrides: {},
      refresh: false
    })

    await discoverMethod().handler({ cwd: '/repo', refresh: true }, makeContext({}))
    expect(vi.mocked(discoverSkillsOnTarget)).toHaveBeenLastCalledWith(expect.anything(), [], {
      providerRootOverrides: {},
      refresh: true
    })
  })

  it('accepts a params payload from an older client that cannot send refresh', () => {
    expect(discoverMethod().params?.parse({ cwd: '/repo' })).toEqual({ cwd: '/repo' })
  })
})

describe('skills.install RPC', () => {
  it('routes one bundle request without changing the single-skill method', async () => {
    const installSharedSkillBundleRequest = vi.fn(async () => ({ status: 'complete' }))
    const request = {
      operationId: 'operation_1',
      package: {
        packageId: 'package_1',
        versionId: 'version_1',
        bundleDigest: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        compressedBytes: 100
      },
      selectedSkillIds: ['alpha'],
      ingress: {
        kind: 'download-grant' as const,
        url: 'https://storage.googleapis.com/package',
        expiresAt: '2026-08-11T12:00:00.000Z'
      },
      destination: { scope: 'global' as const },
      conflictDecisions: []
    }

    await method('skills.installBundle').handler(request, {
      runtime: { installSharedSkillBundleRequest }
    } as unknown as RpcContext)

    expect(installSharedSkillBundleRequest).toHaveBeenCalledWith(request, undefined)
  })

  it('delegates installation to the executing runtime service', async () => {
    const installSharedSkillRequest = vi.fn(async () => ({ status: 'installed' }))
    const runtime = {
      installSharedSkillRequest
    }
    const request = {
      operationId: 'operation_1',
      package: {
        packageId: 'package_1',
        versionId: 'version_1',
        packageDigest: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        compressedBytes: 100
      },
      ingress: {
        kind: 'download-grant' as const,
        url: 'https://storage.googleapis.com/package',
        expiresAt: '2026-08-11T12:00:00.000Z'
      },
      destination: { scope: 'global' as const }
    }
    await installMethod().handler(request, { runtime } as unknown as RpcContext)
    expect(installSharedSkillRequest).toHaveBeenCalledWith(request, undefined)
  })

  it('downgrades cancelled results for clients without the additive result capability', async () => {
    const cancelled = {
      operationId: 'operation_1',
      status: 'cancelled' as const,
      name: 'example',
      packageDigest: 'a'.repeat(64),
      placements: [],
      failure: {
        category: 'cancelled' as const,
        code: 'skill-install-cancelled',
        retryable: true
      }
    }
    const runtime = { installSharedSkillRequest: vi.fn(async () => cancelled) }
    const request = {
      operationId: 'operation_1',
      package: {
        packageId: 'package_1',
        versionId: 'version_1',
        packageDigest: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        compressedBytes: 100
      },
      ingress: {
        kind: 'download-grant' as const,
        url: 'https://storage.googleapis.com/package',
        expiresAt: '2026-08-11T12:00:00.000Z'
      },
      destination: { scope: 'global' as const }
    }

    await expect(
      installMethod().handler(request, { runtime, clientCapabilities: [] } as unknown as RpcContext)
    ).resolves.toMatchObject({ status: 'failed', errorCategory: 'skill-install-cancelled' })
    await expect(
      installMethod().handler(request, {
        runtime,
        clientCapabilities: ['skills.install-result.v2']
      } as unknown as RpcContext)
    ).resolves.toMatchObject({ status: 'cancelled', failure: { category: 'cancelled' } })
  })

  it('routes cancellation to the destination runtime by operation ID', async () => {
    const cancelSharedSkillInstall = vi.fn(() => true)
    const result = await method('skills.cancelInstall').handler({ operationId: 'operation_1' }, {
      runtime: { cancelSharedSkillInstall }
    } as unknown as RpcContext)
    expect(result).toEqual({ cancelled: true })
    expect(cancelSharedSkillInstall).toHaveBeenCalledWith('operation_1')
  })

  it('returns active bundle progress without requiring it from older clients', async () => {
    const progress = {
      operationId: 'operation_1',
      skillId: 'alpha',
      skillName: 'alpha',
      skillIndex: 1,
      skillCount: 2
    }
    const getSharedSkillInstallProgress = vi.fn(() => progress)
    expect(
      method('skills.getInstallProgress').handler({ operationId: 'operation_1' }, {
        runtime: { getSharedSkillInstallProgress }
      } as unknown as RpcContext)
    ).toEqual(progress)
  })
})

describe('skills.share RPC', () => {
  const request = {
    skillSelectors: ['alpha', 'beta'],
    bundleName: 'team-skills',
    releaseNotes: '',
    target: { cwd: '/repo' }
  }

  beforeEach(() => {
    vi.mocked(discoverSkillsOnTarget).mockClear()
    vi.mocked(resolveSkillDiscoveryTarget).mockImplementation((target) => ({
      kind: 'native-host',
      cwd: target?.cwd ?? undefined
    }))
  })

  it('checks permission before discovery', async () => {
    const denial = new Error('denied')
    const assertAgentSkillSharingAllowed = vi.fn(() => {
      throw denial
    })

    await expect(
      method('skills.share').handler(request, {
        runtime: { assertAgentSkillSharingAllowed }
      } as unknown as RpcContext)
    ).rejects.toBe(denial)
    expect(discoverSkillsOnTarget).not.toHaveBeenCalled()
  })

  it('discovers on the executing host and delegates the selected bundle', async () => {
    const discoveredSkills = [{ id: 'alpha' }, { id: 'beta' }]
    vi.mocked(discoverSkillsOnTarget).mockResolvedValueOnce({
      skills: discoveredSkills,
      sources: [],
      scannedAt: 1
    } as never)
    const publishDiscoveredSkillsFromAgent = vi.fn(async () => ({ status: 'ok' }))
    const runtime = {
      assertAgentSkillSharingAllowed: vi.fn(),
      resolveProjectRuntimeForWorktree: vi.fn(),
      resolveSkillDiscoveryProviderRoots: vi.fn(async () => ({})),
      listRepos: vi.fn(() => []),
      publishDiscoveredSkillsFromAgent
    }
    const signal = new AbortController().signal

    await method('skills.share').handler(request, { runtime, signal } as unknown as RpcContext)

    expect(discoverSkillsOnTarget).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'native-host', cwd: '/repo' }),
      [],
      { providerRootOverrides: {}, refresh: true }
    )
    expect(publishDiscoveredSkillsFromAgent).toHaveBeenCalledWith(request, discoveredSkills, signal)
  })

  it('rejects WSL before attempting to read Linux paths with native fs', async () => {
    vi.mocked(resolveSkillDiscoveryTarget).mockReturnValueOnce({
      kind: 'wsl',
      distro: 'Ubuntu',
      homeDir: '/home/alice',
      cwd: '/repo'
    })
    const runtime = {
      assertAgentSkillSharingAllowed: vi.fn(),
      resolveProjectRuntimeForWorktree: vi.fn()
    }

    await expect(
      method('skills.share').handler(request, { runtime } as unknown as RpcContext)
    ).rejects.toMatchObject({ code: 'agent_skill_sharing_unsupported_environment' })
    expect(discoverSkillsOnTarget).not.toHaveBeenCalled()
  })

  it('rejects paired runtime callers before discovery', async () => {
    const runtime = {
      assertAgentSkillSharingAllowed: vi.fn()
    }

    await expect(
      method('skills.share').handler(request, {
        runtime,
        clientKind: 'runtime'
      } as unknown as RpcContext)
    ).rejects.toMatchObject({ code: 'agent_skill_sharing_unsupported_environment' })
    expect(discoverSkillsOnTarget).not.toHaveBeenCalled()
  })
})

describe('skill management RPC', () => {
  it('delegates preview and removal to the executing runtime', async () => {
    const previewSharedSkillInstallRequest = vi.fn(async () => ({ currentState: 'missing' }))
    const removeSharedSkillInstallRequest = vi.fn(async () => ({ status: 'removed' }))
    const runtime = { previewSharedSkillInstallRequest, removeSharedSkillInstallRequest }
    const destination = { scope: 'global' as const }
    const packageIdentity = {
      packageId: 'package_1',
      versionId: 'version_1',
      packageDigest: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      compressedBytes: 100
    }

    await method('skills.previewInstall').handler(
      { name: 'example', package: packageIdentity, destination },
      { runtime } as unknown as RpcContext
    )
    await method('skills.removeInstall').handler(
      { operationId: 'operation_1', name: 'example', destination },
      { runtime } as unknown as RpcContext
    )

    expect(previewSharedSkillInstallRequest).toHaveBeenCalledOnce()
    expect(removeSharedSkillInstallRequest).toHaveBeenCalledOnce()
  })
})
