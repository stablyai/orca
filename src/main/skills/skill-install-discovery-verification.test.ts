import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillInstallResult } from '../../shared/skill-install-contract'
import type { SkillDiscoveryResult } from '../../shared/skills'

const { discoverSkillsInWslMock } = vi.hoisted(() => ({
  discoverSkillsInWslMock: vi.fn()
}))

vi.mock('./skill-discovery-wsl', () => ({
  discoverSkillsInWsl: discoverSkillsInWslMock
}))

import { verifySkillInstallDiscovery } from './skill-install-discovery-verification'

function installResult(paths: string[]): SkillInstallResult {
  return {
    operationId: 'operation-wsl',
    status: 'installed',
    name: 'review',
    packageDigest: 'a'.repeat(64),
    canonicalPath: paths[0],
    placements: paths.map((path, index) => ({
      provider: index === 0 ? 'agent-skills' : 'claude',
      path,
      topology: index === 0 ? 'canonical-copy' : 'provider-alias',
      status: 'installed'
    }))
  }
}

function discovery(rootPaths: string[]): SkillDiscoveryResult {
  return {
    skills: [
      {
        id: 'review',
        name: 'review',
        description: 'Review',
        providers: ['agent-skills', 'claude'],
        sourceKind: 'home',
        sourceLabel: 'Agent skills home',
        rootPath: rootPaths[0],
        rootPaths,
        directoryPath: `${rootPaths[0]}/review`,
        skillFilePath: `${rootPaths[0]}/review/SKILL.md`,
        installed: true,
        updatedAt: null
      }
    ],
    sources: [],
    scannedAt: 1
  }
}

beforeEach(() => {
  discoverSkillsInWslMock.mockReset()
})

describe('WSL install discovery verification', () => {
  it('matches UNC placements against distro-native discovery paths', async () => {
    discoverSkillsInWslMock.mockResolvedValue(
      discovery(['/home/alice/.agents/skills', '/home/alice/.claude/skills'])
    )
    const result = await verifySkillInstallDiscovery({
      result: installResult([
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.agents\\skills\\review',
        '\\\\wsl$\\ubuntu\\home\\alice\\.claude\\skills\\review'
      ]),
      scope: 'global',
      homeDirectory: '\\\\wsl.localhost\\Ubuntu\\home\\alice',
      wslDistro: 'Ubuntu'
    })

    expect(result.status).toBe('installed')
    expect(result.placements).not.toContainEqual(expect.objectContaining({ status: 'failed' }))
    expect(discoverSkillsInWslMock).toHaveBeenCalledWith({
      distro: 'Ubuntu',
      homeDir: '/home/alice',
      cwd: '/home/alice'
    })
  })

  it('normalizes Windows-backed workspace paths to drvfs paths', async () => {
    discoverSkillsInWslMock.mockResolvedValue(discovery(['/mnt/c/work/repo/.agents/skills']))
    const result = await verifySkillInstallDiscovery({
      result: installResult(['C:\\work\\repo\\.agents\\skills\\review']),
      scope: 'workspace',
      homeDirectory: 'C:\\Users\\alice',
      workspaceDirectory: 'C:\\work\\repo',
      wslDistro: 'Ubuntu'
    })

    expect(result.status).toBe('installed')
    expect(discoverSkillsInWslMock).toHaveBeenCalledWith({
      distro: 'Ubuntu',
      homeDir: '/mnt/c/Users/alice',
      cwd: '/mnt/c/work/repo'
    })
  })

  it('scans a managed WSL Claude config root used by the target session', async () => {
    const managedRoot = '/home/alice/.local/share/orca/claude-accounts/account-1/auth/skills'
    discoverSkillsInWslMock.mockResolvedValue(
      discovery(['/home/alice/.agents/skills', managedRoot])
    )
    const result = await verifySkillInstallDiscovery({
      result: installResult([
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.agents\\skills\\review',
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\claude-accounts\\account-1\\auth\\skills\\review'
      ]),
      scope: 'global',
      homeDirectory: '\\\\wsl.localhost\\Ubuntu\\home\\alice',
      wslDistro: 'Ubuntu',
      providerRootOverrides: {
        claude:
          '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\claude-accounts\\account-1\\auth\\skills'
      }
    })

    expect(result.status).toBe('installed')
    expect(discoverSkillsInWslMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerRootOverrides: { claude: managedRoot } })
    )
  })

  it('fails verification without scanning a mismatched UNC distro', async () => {
    const result = await verifySkillInstallDiscovery({
      result: installResult(['\\\\wsl.localhost\\Debian\\home\\alice\\.agents\\skills\\review']),
      scope: 'global',
      homeDirectory: '\\\\wsl.localhost\\Debian\\home\\alice',
      wslDistro: 'Ubuntu'
    })

    expect(result).toMatchObject({
      status: 'failed',
      errorCategory: 'skill-discovery-verification-failed'
    })
    expect(discoverSkillsInWslMock).not.toHaveBeenCalled()
  })
})
